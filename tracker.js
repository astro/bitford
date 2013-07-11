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
	    if (peers && peers.__proto__ && peers.__proto__.constructor === Array) {
		/* Non-compact IPv4 */
		peers.forEach(this.torrent.addPeer.bind(this.torrent));
	    }
	    if (peers && peers.__proto__ && peers.__proto__.constructor === Uint8Array) {
		/* Compact IPv4 */
		for(var i = 0; i < peers.length; i += 6) {
		    var ip = [0, 1, 2, 3].map(function(j) { return peers[i + j]; }).join(".");
		    var port = (peers[i + 4] << 8) | peers[i + 5];
		    this.torrent.addPeer({ ip: ip, port: port });
		}
	    }

	    var peers6 = response && response.peers6;
	    if (peers6 && peers6.prototype && peers6.prototype.constructor === Array) {
		/* Non-compact IPv6 */
		peers6.forEach(this.torrent.addPeer.bind(torrent));
	    }
	    if (peers6 && peers6.__proto__ && peers6.__proto__.constructor === Uint8Array) {
		/* Compact IPv6 */
		for(var i = 0; i < peers6.length; i += 18) {
		    var ip = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(function(j) { return (peers6[i + j * 2] << 8 | peers6[i + j * 2 + 1]).toString(16); }).join(":");
		    var port = (peers[i + 16] << 8) | peers[i + 17];
		    this.torrent.addPeer({ ip: ip, port: port });
		}
	    }

	    var interval = (response.interval || 30 + 30 * Math.random()) * 1000;
	    this.timeout = setTimeout(this.start.bind(this), Math.ceil(interval));
	}.bind(this));
    },

    stop: function() {
	// TODO: do event req
	if (this.timeout) {
	    clearTimeout(this.timeout);
	    this.timeout = null;
	}
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
	var m;

	if ((/^https?:\/\//.test(this.url)))
	    return this.requestHTTP(cb);
	else if ((m = this.url.match(/^udp:\/\/([^:]+):(\d+)/)))
	    return this.requestUDP(m[1], parseInt(m[2]), cb);
    },

    requestHTTP: function(cb) {
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
    },

    requestUDP: function(address, port, cb) {
	var infoHash = this.torrent.infoHash,
	    peerId = this.torrent.peerId;

	new UDPSocket(function(sock) {
	    function send(data, filterCb, doneCb) {
		console.log("sendTo", data, address, port);
		sock.sendTo(data, address, port);
		sock.onData = function(rData, rAddress, rPort) {
		    var result;
		    if ((result = filterCb(rData))) {
			sock.onData = null;
			doneCb(result);
		    }
		};
		// TODO: timeout + retrying
	    }

	    var transactionId = Math.floor(Math.pow(2,32) * Math.random());
	    var connectReq = new Uint8Array([
		0, 0, 0x4, 0x17, 0x27, 0x10, 0x19, 0x80,  /* connection_id */
		0, 0, 0, 0,  /* action: connect */
		0, 0, 0, 0  /* transaction_id, see below */
	    ]);
	    (new DataView(connectReq.buffer)).setUint32(12, transactionId);

	    send(connectReq.buffer, function(connectRes) {
		var d = new DataView(connectRes);
		if (d.byteLength >= 16 &&
		    d.getUint32(0) === 0 &&
		    d.getUint32(4) === transactionId) {
		    var connectionId = [d.getUint32(8), d.getUint32(12)];
		    return connectionId;
		}
	    }, function(connectionId) {
		transactionId = Math.floor(Math.pow(2,32) * Math.random());
		var announceReq = new Uint8Array([
		    0, 0, 0, 0, 0, 0, 0, 0,  /* connection_id */
		    0, 0, 0, 1,  /* action: announce */
		    0, 0, 0, 0,  /* transaction_id, see below */
		    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  /* info_hash */
		    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  /* peer_id */
		    0, 0, 0, 0, 0, 0, 0, 0,  /* TODO: downloaded */
		    0, 0, 0, 0, 0, 0, 0, 0,  /* TODO: left */
		    0, 0, 0, 0, 0, 0, 0, 0,  /* TODO: uploaded */
		    0, 0, 0, 2,  /* TODO: event */
		    0, 0, 0, 0,  /* ip */
		    0, 0, 0, 0,  /* TODO: key */
		    0xff, 0xff, 0xff, 0xff,  /* num_want */
		    0x1a, 0xe1,  /* TODO: port */
		    0, 0  /* extensions */
		]);
		var d = new DataView(announceReq.buffer);
		d.setUint32(0, connection_id[0]);
		d.setUint32(4, connection_id[1]);
		d.setUint32(12, transactionId);
		var i;
		for(i = 0; i < 20; i++) {
		    d.setInt8(16 + i, infoHash[i]);
		}
		for(i = 0; i < 20; i++) {
		    d.setInt8(36 + i, peerId[i]);
		}
		send(announceReq, function(announceRes) {
		    var d = new DataView(announceRes);
		    if (d.byteLength >= 20 &&
			d.getUint32(0) === 1 &&
			d.getUint32(4) === transactionId) {
			var connectionId = [d.getUint32(8), d.getUint32(12)];
			return {
			    interval: d.getUint32(8),
			    peers: new Uint8Array(announceRes.slice(20))
			};
		    }
		}, cb);
	    });
	});
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
