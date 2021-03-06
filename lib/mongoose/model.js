/*jshint node:true*/
"use strict";

var queryHelpers = require("./query"),

	mongoose = require("mongoose"),
	CastError = mongoose.SchemaType.CastError,
	DocumentArray = mongoose.Types.DocumentArray;



/*!
 * Misc helpers
 */


function getObject(req, item) {
	if (typeof item.toObject === "function") {
		return item.toObject(req.options.toObject);
	} else {
		return item;
	}
}



/*!
 * Document resource handlers
 */


function mongooseCollCount(req, cb) {
	var query = req.options.query();

	if (req.param("query")) {
		// Cache query operator
		if (!req._queryOperator) {
			req._queryOperator = queryHelpers.create(req.param("query"));
		}

		query = query.find(req._queryOperator);
	}

	query.count(function(err, count) { cb(err, count); });
}


function mongooseCollList(req, offset, limit, cb) {
	var options = req.options;
	var query = options.query();

	if (req.param("query")) {
		// Cache query operator
		if (!req._queryOperator) {
			req._queryOperator = queryHelpers.create(req.param("query"));
		}

		query = query.find(req._queryOperator);
	}

	query = query.skip(offset).limit(limit);

	if (options.sort) {
		query = query.sort(options.sort);
	}

	return query.exec(function(err, items) {
		if (err) {
			cb(err);
		} else {
			cb(null, items.map(function(item) {
				var obj = getObject(req, item);
				return obj;
			}));
		}
	});
}

function mongooseCollPost(req, cb) {
	var model = req.mongoose.model;

	model.create(req.body, function(err) {
		if (err) {
			cb(err);
		} else {
			cb.created();
		}
	});
}



/*!
 * Document resource handlers
 */


function mongooseDocHook(req, next) {
	var options = req.options;

	var crit = {};
	crit[options.key] = req.params.id;
	req.mongoose.path += "/" + req.params.id;

	options.query().find(crit).findOne(function(err, item) {
		if (err instanceof CastError || !item) {
			return next.notFound();
		}

		if (err) {
			return next(err);
		}

		req.mongoose.doc = item;
		next();
	});
}


function mongooseDocGet(req, cb) {
	cb(null, getObject(req, req.mongoose.doc));
}


function mongooseDocPut(req, isPatch, cb) {
	var doc = req.mongoose.doc;

	doc.set(req.body);
	doc.save(function(err) {
		cb(err);
	});
}


function mongooseDocDel(req, cb) {
	req.mongoose.doc.remove(function(err) {
		cb(err);
	});
}



/*!
 * Document path resource handlers
 */


function mongoosePathHook(req, next) {
	var doc = req.mongoose.doc;
	var docpath = req.mongoose.path;
	var subkeys = req.options.subkeys;

	var path = req.params["*"];
	var parts = path.split("/");

	var fullpath = docpath;
	var current = doc;
	var parent = doc;
	var link = {};

	while(parts.length > 0) {
		var part = parts.shift();
		fullpath += "/" + part;

		var decoded = decodeURIComponent(part);

		if (current instanceof DocumentArray) {
			parent = current;

			var key = "_id";
			if (subkeys) {
				if (typeof subkeys === "string") {
					key = subkeys;
				} else {
					Object.keys(subkeys).forEach(function(pattern) {
						if (req.match(pattern, fullpath)) {
							key = subkeys[pattern];
						}
					});
				}
			}

			if (key !== "_id") {
				current = current.filter(function(item) {
					return item[key] === decoded;
				})[0];

				link = { id: current._id };
			} else {
				current = current.id(decoded);
				link = { id: decoded };
			}
		} else {
			if ("field" in link) {
				link.field += "." + decoded;
			} else {
				parent = current;
				link = { field: decoded };
			}

			current = parent.get(link.field);
		}

		if (!current) {
			return next.notFound();
		}
	}

	req.mongoose.parent = parent;
	req.mongoose.item = current;
	req.mongoose.link = link;

	next();
}


function mongoosePathGet(req, cb) {
	var item = req.mongoose.item;

	if (item instanceof DocumentArray) {
		cb.list(mongooseDocArrayCount, mongooseDocArrayList);
	} else {
		cb(null, getObject(req, item));
	}
}


function mongoosePathPut(req, isPatch, cb) {
	var parent = req.mongoose.parent;
	var link = req.mongoose.link;
	var doc = req.mongoose.doc;
	var value = req.body;

	if ("_value" in value) {
		value = value._value;
	}

	if ("id" in link) {
		parent.id(link.id).set(value);
	} else if ("field" in link) {
		parent.set(link.field, value);
	} else {
		return cb(new Error("Unknown link type"));
	}

	doc.save(function(err) {
		cb(err);
	});
}


function mongoosePathDel(req, cb) {
	var parent = req.mongoose.parent;
	var link = req.mongoose.link;
	var doc = req.mongoose.doc;

	if ("id" in link) {
		parent.splice(parent.indexOf(parent.id(link.id)), 1);
	} else if ("field" in link) {
		parent.set(link.field, undefined);
	} else {
		return cb(new Error("Unknown link type"));
	}

	doc.save(function(err) {
		cb(err);
	});
}


function mongoosePathPost(req, cb) {
	var item = req.mongoose.item;

	if (!(item instanceof DocumentArray)) {
		return cb.methodNotAllowed();
	}

	mongooseDocArrayPost(req, cb);
}



/*!
 * Mongoose DocumentArray helpers
 */


function queryDocArray(req) {
	var docArray = req.mongoose.item;

	if (req.param("query")) {
		// Cache query result
		if (!req.mongoose._queryResult) {
			req.mongoose._queryResult = docArray.filter(
				queryHelpers.match.bind(
					null,
					queryHelpers.create(req.param("query"))
				)
			);
		}

		return req.mongoose._queryResult;
	} else {
		return docArray;
	}
}


function mongooseDocArrayCount(req, cb) {
	var len = queryDocArray(req).length;
	cb(null, len);
}


function mongooseDocArrayList(req, offset, limit, cb) {
	var items = queryDocArray(req);

	if (limit > 0) {
		items = items.slice(offset, offset + limit);
	} else {
		items = items.slice(offset);
	}

	cb(null, items);
}


function mongooseDocArrayPost(req, cb) {
	var docArray = req.mongoose.item;
	var doc = req.mongoose.doc;
	var index = NaN;

	if (req.param("index")) {
		index = Number(req.param("index"));
	}

	if (isNaN(index)) {
		index = docArray.length;
	}

	docArray.splice(Math.max(0, Math.min(docArray.length, index)), 0, req.body);

	doc.save(function(err) {
		if (err) {
			cb(err);
		} else {
			cb.created();
		}
	});
}


/*!
 * Mongoose resource definition helper
 */


function mongooseResource(name, Model) {
	/*jshint validthis:true*/
	var collResource = this.sub(name)
		.hook(function modelHook(req, next) {
			req.mongoose = { model: Model, path: name };
			next();
		})
		.count(mongooseCollCount)
		.list(mongooseCollList)
		.post(mongooseCollPost)
		.set("query", function mongooseDefaultQuery() { return Model.find(); })
		.set("key", "_id");

	var docResource = collResource.sub(":id")
		.hook(mongooseDocHook)
		.get(mongooseDocGet)
		.put(mongooseDocPut)
		.del(mongooseDocDel);

	docResource.sub("*", mongoosePathHook)
		.get(mongoosePathGet)
		.put(mongoosePathPut)
		.del(mongoosePathDel)
		.post(mongoosePathPost);

	return collResource;
}

module.exports = mongooseResource;
