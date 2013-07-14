/**
 * Puts all the data in multiple files seperated by offsets, to
 * alleviate lack of sparse files.
 */
function StoreBackend(basename) {
    this.basename = basename;

    /* Initialize offsets */
    var offsets = this.offsets = [0];
    /* Look for existing offsets */
    requestFileSystem_(window.PERSISTENT, 0, function(fs) {
	var reader = fs.root.createReader();
	reader.readEntries(function(entry) {
	    var m;
	    if (entry.isFile &&
		(m = entry.name.match(/^([0-9a-f]{40}\.(\d+)$/)) &&
		m[1] === basename) {

		offsets.push(parseInt(m[2], 10));
	    }
	});
    });
}

StoreBackend.prototype = {
    readUpTo: function(offset, maxLength, cb) {
	var previousOffset = 0;
	for(var i = 0; i < this.offsets.length && this.offsets[i] <= offset; i++)
	    previousOffset = this.offsets[i];
	var partOffset = offset - previousOffset;

	requestFileSystem_(window.PERSISTENT, 0, function(fs) {
	    fs.root.getFile(this.basename + "." + previousOffset, {
		create: true
	    }, function(entry) {
		entry.file(function(file) {
		    var reader = new FileReader();
		    reader.onload = function() {
			cb(reader.result);
		    };
		    reader.onerror = function(error) {
			console.error("readUpTo", offset, maxLength, error);
			cb();
		    };
		    reader.readAsArrayBuffer(file.slice(partOffset, partOffset + maxLength));
		});
	    });
	}.bind(this));
    },

    read: function(offset, length, cb) {
	var result = new BufferList();

	var readFrom = function(offset, remain) {
	    if (remain < 1)
		return cb(result);

	    this.readUpTo(offset, remain, function(data) {
		var len = data ? data.byteLength : 0;
		if (len > 0) {
		    result.append(data);
		    readFrom(offset + len, remain - len);
		} else {
		    console.error("Read", len, "instead of", remain);
		    return cb(result);
		}
	    });
	}.bind(this);
	readFrom(offset, length);
    },

    write: function(offset, data, cb) {
	var previousOffset = 0;
	for(var i = 0; i < this.offsets.length && this.offsets[i] <= offset; i++)
	    previousOffset = this.offsets[i];
	var partOffset = offset - previousOffset;

	requestFileSystem_(window.PERSISTENT, 0, function(fs) {
	    fs.root.getFile(this.basename + "." + previousOffset, {
		create: true
	    }, function(entry) {
		entry.file(function(file) {
		    if (file.size < partOffset) {
			/* Create new part for sparseness */
			this.offsets.splice(i, 0, [offset]);
			// TODO: slice data
			return this.write(offset, data, cb);
		    }

		    entry.createWriter(function(writer) {
			writer.onwriteend = function() {
			    cb();
			};
			writer.onerror = function(error) {
			    console.error("write", error);
			    cb();
			};
			writer.seek(partOffset);
			writer.write(data.toBlob());
		    });
		}.bind(this));
	    }.bind(this));
	}.bind(this));
    },

    remove: function() {
	requestFileSystem_(window.PERSISTENT, 0, function(fs) {
	    this.offsets.forEach(function(offset) {
		fs.root.getFile(this.basename + "." + this.offset, {}, function(entry) {
		    entry.remove(function() { });
		});
	    }.bind(this));
	}.bind(this));
    }
};

var requestFileSystem_ = window.requestFileSystem ||
    window.webkitRequestFileSystem;
