function Torrent(meta) {
    console.log("new Torrent", meta);
    this.name = UTF8ArrToStr(meta.info.name);
    this.pieces = Math.floor(meta.info.pieces.byteLength / 20);
    this.infoHash = meta.infoHash;
    this.peerId = "-BF000-xxxxxxxxxxxxx";
    this.peers = [];
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

function Peer(torrent, info) {
    this.torrent = torrent;
    this.ip = info.ip;
    this.port = info.port;

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
	console.log(this.ip, "sendLength", l);
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
	console.log(this.ip, "sent bitfield", bitfield);
    },

    onData: function(data) {
	console.log(this.ip, "onData", data);
	if (this.buffer) {
	    concatArrays([this.buffer, data], function(data) {
		this.buffer = null;
		this.processData(data);
	    }.bind(this));
	} else
	    this.processData(new Uint8Array(data));
    },

    processData: function(data) {
	console.log(this.ip, "processData", data);
	var fail = function(msg) {
	    this.sock.end();
	    this.state = "error";
	    this.error = msg;
	}.bind(this);

	if (this.state === 'handshake' && data.length >= 20 + 8 + 20 + 20) {
	    if (data[0] != 19 ||
		UTF8ArrToStr(new Uint8Array(data.subarray(1, 20))) != "BitTorrent protocol") {
		return fail("Handshake mismatch");
	    }
	    var infoHash = new Uint8Array(data.subarray(20 + 8, 20 + 8 + 20));
	    for(var i = 0; i < 20; i++) {
		if (infoHash[i] != this.torrent.infoHash[i])
		    return fail("InfoHash mismatch");
	    }
	    this.peerId = data.subarray(20 + 8 + 20, 20 + 8 + 20 + 20);
	    this.sendBitfield();
	    this.state = 'connected';
	    this.buffer = new Uint8Array(data.subarray(20 + 8 + 20 + 20));
	} else if (this.state === 'connected' && data.length >= 4) {
	    var len = data[0] << 24 |
		data[1] << 16 |
		data[2] << 8 |
		data[3];
	    if (data.length >= 4 + len) {
		this.handleMessage(new Uint8Array(data.subarray(4, 4 + len)));
		this.buffer = new Uint8Array(data.subarray(4 + len));
	    } else {
		this.buffer = data;
	    }
	} else {
	    this.buffer = data;
	}

	if (this.buffer && this.buffer.length !== data.length) {
	    var buffer = this.buffer;
	    this.buffer = null;
	    this.processData(buffer);
	}
    },

    handleMessage: function(data) {
	console.log(this.ip, "handleMessage", data[0], data);
	var piece;
	switch(data[0]) {
	    case 0:
		/* Unchoke */
		this.choked = false;
		break;
	    case 1:
		/* Choke */
		this.choked = true;
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
		piece = data[3] << 24 |
		    data[2] << 16 |
		    data[1] << 8 |
		    data[0];
		if (this.bitfield.length >= Math.floor(piece / 8))
		    this.bitfield[Math.floor(piece / 8)] |= 1 << (7 - (piece % 8));
		break;
	    case 5:
		/* Bitfield */
		this.bitfield = new Uint8Array(data.subarray(1));
		console.log("Bitfield", this.bitfield);
		console.log("%", this.getDonePercent());
		break;
	    case 6:
		/* Request */
		break;
	    case 7:
		/* Piece */
		break;
	    case 8:
		/* Cancel */
		break;
	}
    },

    getDonePercent: function() {
	if (!this.bitfield)
	    return 0;

	var present = 0;
	for(var i = 0; i < this.bitfield.length; i++) {
	    var b = this.bitfield[i];
	    for(var j = 0; j < 8; j++)
		if (b & (1 << j))
		    present++;
	}
	return Math.floor(100 * Math.max(1, present / this.torrent.pieces));
    }
};

function concatArrays(arrays, cb) {
    var blob = new Blob(arrays);
    var reader = new FileReader();
    reader.onload = function() {
	cb(new Uint8Array(reader.result));
    };
    reader.readAsArrayBuffer(blob);
}
