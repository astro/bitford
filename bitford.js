function Torrent(meta) {
    console.log("new Torrent", meta);
    this.name = UTF8ArrToStr(meta.info.name);
    this.pieces = Math.floor(meta.info.pieces.byteLength / 20);
    this.infoHash = meta.infoHash;
    this.peerId = "-BF000-xxxxxxxxxxxxx";
    this.peers = [];
    var pieceLength;
    if (typeof meta.info['piece length'] == 'number')
	pieceLength = meta.info['piece length'];
    else
	throw "Invalid torrent: no piece length";

    /* Init Storage */
    var name = UTF8ArrToStr(meta.info.name);
    if (typeof meta.info.length == 'number')
	this.store = new Store([{ path: [name], size: meta.info.length }], pieceLength);
    else if (meta.info.files.__proto__.constructor == Array)
	this.store = new Store(meta.info.files.map(function(file) {
	    return { path: [name].concat(file.path.map(UTF8ArrToStr)),
		     size: file.length
		   };
	}), pieceLength);
    else
	throw "Invalid torrent: no files";

    /* Init trackers */
    if (meta['announce-list'])
	this.trackers = meta['announce-list'].map(function(urls) {
	    urls = urls.map(UTF8ArrToStr);
	    return new TrackerGroup(this, urls);
	}.bind(this));
    else if (meta.announce)
	this.trackers = [new TrackerGroup(this, [UTF8ArrToStr(meta.announce)])];
    else
	console.warn("No tracker in torrent file");

    // Can defer:
    this.trackers.forEach(function(tg) { tg.start() });
    console.log("Torrent", this);
}

Torrent.prototype = {
    addPeer: function(info) {
	this.peers.push(new Peer(this, info));
    },
    getBitfield: function() {
	var result = new Uint8Array(Math.ceil(this.pieces / 8));
	return result;
    }
};


function TrackerGroup(torrent, urls) {
    this.torrent = torrent;
    this.trackers = urls.map(function(url) {
	return new Tracker(torrent, url);
    });
}
TrackerGroup.prototype = {
    start: function() {
	this.trackers[0].request(function(error, response) {
	    /* Rotate in group */
	    this.trackers.push(this.trackers.shift());

	    var peers = response && response.peers;
	    if (peers && peers.prototype && peers.prototype.constructor === Array) {
		/* Non-compact IPv4 */
		peers.forEach(this.torrent.addPeer.bind(torrent));
	    }
	    if (peers && peers.__proto__ && peers.__proto__.constructor === Uint8Array) {
		/* Compact IPv4 */
		for(var i = 0; i < peers.length; i += 6) {
		    var ip = [0, 1, 2, 3].map(function(j) { return peers[i + j]; }).join(".");
		    var port = (peers[i + 4] << 8) | peers[i + 5];
		    this.torrent.addPeer({ ip: ip, port: port });
		}
	    }
	    // TODO: IPv6

	    var interval = (response.interval || 30 + 30 * Math.random()) * 1000;
	    setTimeout(this.start.bind(this), Math.ceil(interval));
	}.bind(this));
    }
};

function Tracker(torrent, url) {
    this.url = url;
console.log("Tracker.url=", url);
    this.torrent = torrent;
    this.started = true;
}
Tracker.prototype = {
    request: function(cb) {
        var query = {
	    info_hash: this.torrent.infoHash,
	    peer_id: this.torrent.peerId,
	    ip: "127.0.0.1",
	    port: 6881,
	    uploaded: 0,
	    downloaded: 0,
	    left: 100,
	    compact: 1
	};
        if (this.started) {
	    this.started = false;
	    query.event = 'started';
	}

        var queryStrs = [];
        for(var k in query) {
	    queryStrs.push(k + "=" + encodeQuery(query[k]));
	}
	console.log("url'", this.url, queryStrs);
        var url = this.url + "?" +
	    queryStrs.join("&");
	console.log("url", url);

        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'blob';
        xhr.onload = function(e) {
	    if (this.status == 200) {
	        var blob = this.response;
	        var reader = new FileReader();
	        reader.onload = function() {
		    console.log("rr", reader.result);
		    var result = BEnc.parse(reader.result);
		    console.log("tr", result);
		    cb(null, result);
		};
		reader.readAsArrayBuffer(blob);
	    }
	};
        xhr.send();
    }
};

function encodeQuery(v) {
    if (v.__proto__.constructor == Uint8Array) {
	var r = "";
	for(var i = 0; i < v.length; i++) {
	    r += "%";
	    if (v[i] < 0x10)
		r += "0";
	    r += v[i].toString(16);
	}
	return r;
    } else {
	return encodeURIComponent("" + v);
    }
}

var MAX_REQS_INFLIGHT = 10;
var REQ_LENGTH = Math.pow(2, 15);

function Peer(torrent, info) {
    this.torrent = torrent;
    this.ip = info.ip;
    this.port = info.port;
    this.direction = 'outgoing';
    this.buffer = new BufferList();
    this.requestedChunks = [];
    // We in them
    this.interesting = false;
    this.choking = true;
    // Them in us
    this.interested = false;
    this.choked = true;

    console.log("Connect peer", this.ip, ":", this.port);
    this.connect();
}

Peer.prototype = {
    connect: function() {
	this.state = 'connecting';
	connectTCP(this.ip, this.port, function(error, sock) {
	    console.log(this.ip, "connectTCP", error, sock);
	    if (error) {
		this.state = 'error';
		this.error = error.message || error.toString();
	    } else {
		this.state = 'handshake';
		this.sock = sock;
		sock.onEnd = function() {
		    delete this.sock;
		    this.state = 'disconnected';
		}.bind(this);
		sock.onData = this.onData.bind(this);
		this.sendHandshake();
	    }
	}.bind(this));
    },

    sendHandshake: function() {
	// "\19BitTorrent protocol"
	this.sock.write(new Uint8Array([
	    19,
	    66, 105, 116, 84,
	    111, 114, 114, 101,
	    110, 116, 32, 112,
	    114, 111, 116, 111,
	    99, 111, 108
	]));
	// Extension bitfield
	this.sock.write(new Uint8Array([
	    0, 0, 0, 0,
	    0, 0, 0, 0
	]));
	// InfoHash
	this.sock.write(this.torrent.infoHash);
	// PeerId
	this.sock.write(strToUTF8Arr(this.torrent.peerId));
    },

    sendLength: function(l) {
	this.sock.write(new Uint8Array([
	    (l >> 24) & 0xff,
	    (l >> 16) & 0xff,
	    (l >> 8) & 0xff,
	    l & 0xff
	]));
    },

    sendBitfield: function() {
	var bitfield = this.torrent.getBitfield();
	this.sendLength(1 + bitfield.byteLength);
	this.sock.write(new Uint8Array([5]));
	this.sock.write(bitfield);
    },

    onData: function(data) {
	this.buffer.append(data);

	var fail = function(msg) {
	    this.sock.end();
	    this.state = 'error';
	    this.error = msg;
	}.bind(this);
	var done = false;
	do {
	    if (this.state === 'handshake' && this.buffer.length >= 20 + 8 + 20 + 20) {
		if (this.buffer.getByte(0) != 19 ||
		    UTF8ArrToStr(new Uint8Array(this.buffer.slice(1, 20))) != "BitTorrent protocol") {
		    return fail("Handshake mismatch");
		}
		for(var i = 0; i < 20; i++) {
		    if (this.buffer.getByte(20 + 8 + i) != this.torrent.infoHash[i])
			return fail("InfoHash mismatch");
		}
		this.peerId = this.buffer.slice(20 + 8 + 20, 20 + 8 + 20 + 20);
		this.sendBitfield();
		this.state = 'connected';
		this.buffer.take(20 + 8 + 20 + 20);
	    } else if (this.state === 'connected' && !this.messageSize && this.buffer.length >= 4) {
		this.messageSize = this.buffer.getWord32BE(0);
		this.buffer.take(4);
	    } else if (this.state === 'connected' && this.messageSize && this.buffer.length >= this.messageSize) {
		this.handleMessage(this.buffer.getBufferList(0, this.messageSize));
		this.buffer.take(this.messageSize);
		this.messageSize = null;
	    } else
		done = true;
	} while(!done);
    },

    handleMessage: function(data) {
	console.log(this.ip, "handleMessage", data.getByte(0), data.length);
	var piece;
	switch(data.getByte(0)) {
	    case 0:
		/* Choke */
		this.choked = true;
		break;
	    case 1:
		/* Unchoke */
		this.choked = false;
		this.canRequest();
		break;
	    case 2:
		/* Interested */
		this.interested = true;
		break;
	    case 3:
		/* Not interested */
		this.interested = false;
		break;
	    case 4:
		/* Have */
		piece = data.getWord32BE(1);
		if (this.bitfield.length >= Math.floor(piece / 8)) {
		    this.bitfield[Math.floor(piece / 8)] |= 1 << (7 - (piece % 8));
		    this.onUpdateBitfield();
		}
		break;
	    case 5:
		/* Bitfield */
		this.bitfield = new Uint8Array(data.slice(1));
		this.onUpdateBitfield();
		break;
	    case 6:
		/* Request */
		break;
	    case 7:
		/* Piece */
		piece = data.getWord32BE(1);
		var offset = data.getWord32BE(5);
		this.requestedChunks = this.requestedChunks.filter(function(chunk) {
		    return chunk.piece !== piece || chunk.offset !== offset;
		});
		this.onPiece(piece, offset, data.getBufferList(9));
		this.canRequest();
		break;
	    case 8:
		/* Cancel */
		break;
	}
    },

    onPiece: function(piece, offset, data) {
	console.log(this.ip, "piece", piece, ":", offset, "+", data.length);
	this.torrent.store.write(piece, offset, data);
    },

    getDonePercent: function() {
	if (!this.bitfield)
	    return 0;

	var present = 0;
	for(var i = 0; i < this.bitfield.length; i++) {
	    var b = this.bitfield[i];
	    if (b == 0xFF)
		present += 8;
	    else
		for(var j = 0; j < 8; j++)
		    if (b & (1 << j))
			present++;
	}
	return Math.floor(100 * Math.max(1, present / this.torrent.pieces));
    },

    has: function(pieceIdx) {
	return !!(this.bitfield[Math.floor(pieceIdx / 8)] & (1 << (7 - (pieceIdx % 8))));
    },

    onUpdateBitfield: function() {
	var interesting = this.torrent.store.isInterestedIn(this);
	if (interesting && !this.interesting) {
	    /* Change triggered */
	    this.interesting = true;
	    this.sendLength(1);
	    /* Interested */
	    this.sock.write(new Uint8Array([2]));
	}
	this.interesting = interesting;
	// TODO: We'll need to send not interested as our pieces complete
    },

    canRequest: function() {
	while(!this.choked && this.requestedChunks.length < MAX_REQS_INFLIGHT) {
	    var chunk = this.torrent.store.nextToDownload(this, REQ_LENGTH);
	    if (!chunk)
		break;

	    this.sendLength(13);
	    var piece = chunk.piece, offset = chunk.offset, length = chunk.length;
	    this.sock.write(new Uint8Array([
		6,
		(piece >> 24) & 0xff, (piece >> 16) & 0xff, (piece >> 8) & 0xff, piece & 0xff,
		(offset >> 24) & 0xff, (offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff,
		(length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff
	    ]));
	    this.requestedChunks.push(chunk);
	}
    }
};

var requestFileSystem_ = window.requestFileSystem ||
    window.webkitRequestFileSystem;
var PersistentStorage_ = navigator.PersistentStorage ||
    navigator.webkitPersistentStorage;

function Store(files, pieceLength) {
    this.size = 0;
    files.forEach(function(file) {
	this.size += file.size;
    }.bind(this));
    this.pieceLength = pieceLength;

    this.pieces = [];
    /* Build pieces... */
    var fileOffset = 0;
    while(files.length > 0) {
	var pieceOffset = 0;
	var chunks = [];
	/* ...from files */
	while(pieceOffset < pieceLength && files.length > 0) {
	    var length = Math.min(pieceLength - pieceOffset, files[0].size - fileOffset);
	    chunks.push({ path: files[0].path,
			  fileOffset: fileOffset,
			  offset: pieceOffset,
			  length: length });
	    pieceOffset += length;
	    fileOffset += length;
	    if (fileOffset >= files[0].size) {
		files.shift();
		fileOffset = 0;
	    }
	}
	this.pieces.push(new StorePiece(chunks));
    }

    /* TODO: start hashing */
}
Store.prototype = {
    isInterestedIn: function(peer) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    if (piece.state !== 'complete' && peer.has(i))
		return true;
	}
	return false;
    },

    nextToDownload: function(peer, chunkLength) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    var chunk = piece.state !== 'complete' &&
		peer.has(i) &&
		piece.nextToDownload(peer, chunkLength);
	    if (chunk) {
		chunk.piece = i;
		console.log("nextToDownload", chunk);
		return chunk;
	    }
	}
	return null;
    },

    write: function(piece, offset, data) {
	if (piece < this.pieces.length)
	    this.pieces[piece].write(offset, data);
    }
};

function StorePiece(chunks) {
    this.chunks = chunks.map(function(chunk) {
	// chunk.state = 'unchecked';
	chunk.state = 'missing';
	return chunk;
    });
}
StorePiece.prototype = {
    state: 'missing',

    /* walks path parts asynchronously */
    withFile: function(parts, cb) {
	// TODO: perhaps serialize accesses
	requestFileSystem_(window.PERSISTENT, 0, function(fs) {
	    var dir = fs.root, partIdx = 0;
	    function walkParts() {
		var part = parts[partIdx];
		partIdx++;
		if (partIdx < parts.length) {
		    dir.getDirectory(part, { create: true }, function(entry) {
			dir = entry;
			walkParts();
		    }, function(err) {
			console.error("getDirectory", part, err);
		    });
		} else {
		    dir.getFile(part, { create: true }, function(entry) {
			entry.file(cb);
		    }, function(err) {
			console.error("getFile", part, err);
		    });
		}
	    }
	    walkParts();
	});
    },

    /* House-keeping to be called when anything updates */
    mergeChunks: function() {
	/* Re-sort by offset */
	var chunks = this.chunks.sort(function(chunk1, chunk2) {
	    return chunk1.offset - chunk2.offset;
	});
	/* Coalesce subsequent chunks */
	var newChunks = [], current;
	for(var i = 0; i < chunks.length; i++) {
	    var chunk = chunks[i];
	    if (current &&
		current.path === chunk.path &&
		current.state !== 'requested' &&
		current.state === chunk.state &&
		current.offset + current.length == chunk.offset) {

		current.length += chunk.length;
	    } else {
		current = chunk;
		newChunks.push(current);
	    }
	}
	/* Eliminate zero-length */
	this.chunks = newChunks.filter(function(chunk) {
	    return chunk.length > 0;
	});
    },

    nextToDownload: function(peer, chunkLength) {
	var result, remain = chunkLength;
	for(var i = 0; i < this.chunks.length && remain > 0; i++) {
	    var chunk = this.chunks[i];
	    if (chunk.state === 'missing') {
		chunk.state = 'requested';
		var length = Math.min(chunk.length, remain);
		remain -= length;
		if (!result)
		    result = {
			offset: chunk.offset,
			length: length
		    };
		else
		    result.length += length;
		if (length < chunk.length) {
		    /* Range ends in the middle of chunk, break it */
		    this.chunks.push({
			state: 'missing',
			path: chunk.path,
			fileOffset: chunk.fileOffset + length,
			offset: chunk.offset + length,
			length: chunk.length - length
		    });
		    chunk.length = length;
		}
	    } else if (result)
		/* No subsequent missing, return now */
		break;
	}
	if (result)
	    this.mergeChunks();
	return result;
    },

    write: function(offset, data) {
	for(var i = 0; i < this.chunks.length; i++) {
	    var chunk = this.chunks[i];
	    var skip = Math.min(offset, chunk.length);
	    offset -= skip;
	    if (offset <= 0) {
		var length = Math.min(data.length, chunk.length);
		//var buf = data.slice(0, length);
		console.log("write", chunk, length);
		data.take(length);

		if (chunk.length > length) {
		    this.chunks.push({
			state: chunk.state,
			path: chunk.path,
			fileOffset: chunk.fileOffset + length,
			offset: chunk.offset + length,
			length: chunk.length - length
		    });
		    chunk.length = length;
		}
		chunk.state = 'written';
	    }
	    if (data.length <= 0) {
		this.mergeChunks();
		break;
	    }
	}
    }
};
