window.indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
window.IDBTransaction = window.IDBTransaction || window.webkitIDBTransaction || window.msIDBTransaction;
window.IDBKeyRange = window.IDBKeyRange || window.webkitIDBKeyRange || window.msIDBKeyRange;

/**
 * Puts all the data in multiple files seperated by offsets, to
 * alleviate lack of sparse files.
 */
function StoreBackend(basename, existingCb) {
    this.key = function(offset) {
	offset = offset.toString(16);
	while(offset.length < 16)
	    offset = "0" + offset;
	return basename + "." + offset;
    };

    var req = indexedDB.open("bitford-store", 1);
    req.onerror = function() {
	console.error("indexedDB", arguments);
    };
    this.onOpenCbs = [];
    req.onupgradeneeded = function(event) {
	var db = event.target.result;
	var objectStore = db.createObjectStore('chunks');
    };
    req.onsuccess = function(event) {
	this.db = event.target.result;
	if (!this.db)
	    throw "No DB";

	var onOpenCbs = this.onOpenCbs;
	delete this.onOpenCbs;
	onOpenCbs.forEach(function(cb) {
	    cb();
	});
    }.bind(this);

    this.remove = function() {
	this.transaction("readwrite", function(objectStore) {
	    var req = objectStore.openCursor(
		IDBKeyRange.lowerBound(this.key(0)),
		'next'
	    );
	    req.onsuccess = function(event) {
		var cursor = event.target.result;
		if (cursor && cursor.key.indexOf(basename + ".") === 0) {
		    objectStore.delete(cursor.key);
		    cursor.continue();
		}
	    };
	    req.onerror = function(e) {
		console.error("cursor", e);
	    };
	}.bind(this));
    };
}

StoreBackend.prototype = {
    /**
     * mode :: "readonly" or "readwrite"
     */
    transaction: function(mode, cb, finalCb) {
	if (this.db) {
	    var tx = this.db.transaction(['chunks'], mode);
	    tx.onerror = function(e) {
		console.error("store tx", e);
		if (finalCb)
		    finalCb(e);
	    };
	    tx.oncomplete = function() {
		if (finalCb)
		    finalCb();
	    };
	    cb(tx.objectStore('chunks'));
	} else {
	    this.onOpenCbs.push(function() {
		this.transaction(mode, cb, finalCb);
	    }.bind(this));
	}
    },

    readFrom: function(offset, cb) {
	this.transaction("readonly", function(objectStore) {
	    var req = objectStore.get(this.key(offset));
	    req.onsuccess = function(event) {
		var data = req.result;
		if (data) {
		    cb(req.result);
		} else {
		    console.error("store readFrom offset too low", offset);
		    cb();
		}
	    }.bind(this);
	    req.onerror = function(e) {
		console.error("store read", offset, e);
		cb();
	    };
	}.bind(this));
    },

    read: function(offset, length, cb) {
	var result = new BufferList();

	var readFrom = function(offset, remain) {
	    if (remain < 1) {
		if (remain < 0)
		    result.take(-result);
		return cb(result);
	    }

	    this.readFrom(offset, function(data) {
		var len = data ? data.byteLength : 0;
		if (len > 0) {
		    result.append(data);
		    readFrom(offset + len, remain - len);
		} else {
		    console.error("Read", len, "instead of", remain, "from", offset);
		    return cb(result);
		}
	    });
	}.bind(this);
	readFrom(offset, length);
    },

    write: function(offset, data, cb) {
	data.readAsArrayBuffer(function(buf) {
	    this.transaction("readwrite", function(objectStore) {
		objectStore.put(buf, this.key(offset));
	    }.bind(this), cb);
	}.bind(this));
    }
};
