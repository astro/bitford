window.indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
window.IDBTransaction = window.IDBTransaction || window.webkitIDBTransaction || window.msIDBTransaction;
window.IDBKeyRange = window.IDBKeyRange || window.webkitIDBKeyRange || window.msIDBKeyRange;

var STORE_DB_VERSION = 2;

/**
 * Puts all the data in multiple files seperated by offsets, to
 * alleviate lack of sparse files.
 */
function StoreBackend(basename, existingCb) {
    this.basename = basename;
    this.key = function(offset) {
	offset = offset.toString(16);
	while(offset.length < 16)
	    offset = "0" + offset;
	return basename + "." + offset;
    };

    var req = indexedDB.open("bitford-store", STORE_DB_VERSION);
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

	/* Recover pre-existing chunks from last session */
	this.existingCb = existingCb;
	var onOpenCbs = this.onOpenCbs;
	delete this.onOpenCbs;
	onOpenCbs.forEach(function(cb) {
	    cb();
	});
	this.recover();
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
    recover: function(start) {
	if (typeof start !== 'number')
	    start = 0;

        this.recovered = start;
	var offset, data;
	this.transaction("readonly", function(objectStore) {
	    var req = objectStore.openCursor(
		IDBKeyRange.lowerBound(this.key(start)),
		'next'
	    );
	    req.onsuccess = function(event) {
		var cursor = event.target.result;
		if (cursor && cursor.key.indexOf(this.basename + ".") === 0) {
		    offset = parseInt(cursor.key.slice(this.basename.length + 1), 16);
		    data = cursor.value;
		}
	    }.bind(this);
	    req.onerror = function(e) {
		console.error("cursor", e);
	    };
	}.bind(this), function() {
	    if (typeof offset === 'number') {
		if (data) {
                    // refit chunks
		    this.existingCb(offset, data, function() {
			this.recover(offset + 1);
		    }.bind(this));
		} else {
		    this.recover(offset + 1);
		}
	    } else {
                delete this.recovered;
                this.onRecoveryDone();
            }
	}.bind(this));
    },

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

    read: function(offset, cb) {
        /* TODO: queue up and fill */
        var data;
	this.transaction("readonly", function(objectStore) {
	    var req = objectStore.openCursor(
                IDBKeyRange.bound(this.key(0), this.key(offset)),
                'prev'
            );
	    req.onsuccess = function(event) {
                var cursor = event.target.result;
                if (cursor && cursor.key.indexOf(this.basename + ".") === 0) {
                    data = cursor.value;
                    var dataOffset = parseInt(cursor.key.slice(this.basename.length + 1), 16);
                    if (dataOffset < offset)
                        data = data.slice(offset - dataOffset);
                }
	    }.bind(this);
	    req.onerror = function(e) {
		console.error("store read", offset, e);
	    };
	}.bind(this), function() {
            cb(data);
        });
    },

    write: function(offset, data, cb) {
	if (typeof data.readAsArrayBuffer === 'function')
	    data.readAsArrayBuffer(function(buf) {
		this.write(offset, buf, cb);
	    }.bind(this));
	else
	    this.transaction("readwrite", function(objectStore) {
		objectStore.put(data, this.key(offset));
	    }.bind(this), cb);
    }
};


function reclaimStorage(activeInfoHashes, finalCb) {
    var active = {};
    console.log("activeInfoHashes", activeInfoHashes);
    activeInfoHashes.forEach(function(infoHash) {
	active[bufferToHex(infoHash)] = true;
    });

    var req = indexedDB.open("bitford-store", STORE_DB_VERSION);
    req.onupgradeneeded = function(event) {
	var db = event.target.result;
	var objectStore = db.createObjectStore('chunks');
    };
    req.onsuccess = function(event) {
	var db = event.target.result;
	if (!db)
	    return;

	var tx = db.transaction(['chunks'], "readwrite");
	var totalReclaimed = 0;
	tx.oncomplete = function() {
	    finalCb(totalReclaimed);
	};

	var objectStore = tx.objectStore('chunks');
	var req = objectStore.openCursor(
	    IDBKeyRange.lowerBound(""),
	    'next'
	);
	req.onsuccess = function(event) {
	    var cursor = event.target.result;
	    if (cursor && cursor.key) {
		var infoHashHex = cursor.key.slice(0, 40);
		if (!active.hasOwnProperty(infoHashHex)) {
		    objectStore.delete(cursor.key);
		    totalReclaimed += cursor.value.byteLength;
		}
		cursor.continue();
	    }
	}
    };
}
