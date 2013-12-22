function TrackerGroup(torrent, urls) {
    this.torrent = torrent;
    this.trackers = urls.map(function(url) {
	return new Tracker(torrent, url);
    });
}
TrackerGroup.prototype = {
    start: function() {
        this.request('started');
    },

    stop: function() {
        this.request('stopped');
    },

    request: function(event) {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }

	this.nextReq = 'now';
	this.trackers[0].request(event, function(error, response) {
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
		peers6 = new DataView(peers6.buffer);
		for(var i = 0; i < peers6.byteLength; i += 18) {
		    var ip = [0, 1, 2, 3, 4, 5, 6, 7].map(function(j) {
			return peers6.getUint16(i + j * 2).toString(16);
		    }).join(":");
		    var port = peers6.getUint16(i + 16);
		    this.torrent.addPeer({ ip: ip, port: port });
		}
	    }

	    var interval = (response && response.interval || 30 + 30 * Math.random()) * 1000;
	    this.nextReq = Date.now() + interval;
            if (this.timeout)
                clearTimeout(this.timeout);
            if (event !== 'stopped')
	        this.timeout = setTimeout(this.start.bind(this), Math.ceil(interval));
	}.bind(this));
    }
};

function Tracker(torrent, url) {
    this.url = url;
    this.torrent = torrent;
}
Tracker.prototype = {
    request: function(event, cb) {
	var m;

	if ((/^https?:\/\//.test(this.url)))
	    return this.requestHTTP(event, cb);
	else if ((m = this.url.match(/^udp:\/\/([^:]+):(\d+)/)))
	    return this.requestUDP(event, m[1], parseInt(m[2]), cb);
    },

    requestHTTP: function(event, cb) {
	var onResponse = function(error, result) {
	    this.error = null;

	    if (result) {
		// TODO: min interval & tracker id
		this.error = result['failure reason'] || result['warning message'];
		this.complete = result.complete;
		this.incomplete = result.incomplete;
	    } else {
		this.error = error && error.message || "Error";
	    }
	    cb(error, result);
	}.bind(this);

        var query = {
	    info_hash: this.torrent.infoHash,
	    peer_id: this.torrent.peerId,
	    ip: "127.0.0.1",
	    port: peerPort,
	    uploaded: this.torrent.bytesUploaded,
	    downloaded: this.torrent.bytesDownloaded,
	    left: this.torrent.store.getBytesLeft(),
	    compact: 1
	};
        if (event) {
	    query.event = event;
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

    requestUDP: function(event, address, port, cb) {
	var infoHash = this.torrent.infoHash,
	    peerId = this.torrent.peerId,
	    torrent = this.torrent;

	connectUDP(address, port, function(err, sock) {
	    var tries = 0;
	    function send(data, filterCb, doneCb) {
		tries++;
		sock.write(data);
		sock.onData = function(rData) {
		    var result;
		    if ((result = filterCb(rData))) {
			console.log("send result", result);
			sock.onData = null;
			clearTimeout(timeout);
			tries = 0;
			doneCb(result);
		    }
		};
		sock.resume();
		var timeout = setTimeout(function() {
		    sock.onData = null;
		    if (tries < 5) {
			send(data, filterCb, doneCb);
		    } else {
			sock.end();
			cb(new Error("Timeout"));
		    }
		}, 5000);
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
		    0, 0, 0, 0, 0, 0, 0, 0,  /* downloaded */
		    0, 0, 0, 0, 0, 0, 0, 0,  /* left */
		    0, 0, 0, 0, 0, 0, 0, 0,  /* uploaded */
		    0, 0, 0, 0,  /* event */
		    0, 0, 0, 0,  /* ip */
		    0, 0, 0, 0,  /* TODO: key */
		    0xff, 0xff, 0xff, 0xff,  /* num_want */
		    0x1a, 0xe1,  /* TODO: port */
		    0, 0  /* extensions */
		]);
		var d = new DataView(announceReq.buffer);
		d.setUint32(0, connectionId[0]);
		d.setUint32(4, connectionId[1]);
		d.setUint32(12, transactionId);
		var i;
		for(i = 0; i < 20; i++) {
		    d.setInt8(16 + i, infoHash[i]);
		}
		for(i = 0; i < 20; i++) {
		    d.setInt8(36 + i, peerId[i]);
		}
		d.setUint32(56, torrent.bytesDownloaded >> 32);
		d.setUint32(60, torrent.bytesDownloaded & 0xffffffff);
		var bytesLeft = torrent.store.getBytesLeft();
		d.setUint32(64, bytesLeft >> 32);
		d.setUint32(68, bytesLeft & 0xffffffff);
		d.setUint32(72, torrent.bytesUploaded >> 32);
		d.setUint32(76, torrent.bytesUploaded & 0xffffffff);
                var eventCode = 0;
                if (event === 'completed')
                    eventCode = 1;
                else if (event === 'started')
                    eventCode = 2;
                else if (event === 'stopped')
                    eventCode = 3;
                d.setUint32(80, eventCode);
		send(announceReq, function(announceRes) {
		    var d = new DataView(announceRes);
		    if (d.byteLength >= 20 &&
			d.getUint32(0) === 1 &&
			d.getUint32(4) === transactionId) {
			var connectionId = [d.getUint32(8), d.getUint32(12)];
			console.log("UDP tracker has", (announceRes.byteLength - 20) / 6, "peers");
			return {
			    interval: d.getUint32(8),
			    peers: new Uint8Array(announceRes.slice(20))
			};
		    }
		}, function(result) {
		    sock.end();
		    cb(null, result);
		});
	    });
	});
    }
};

function encodeQuery(v) {
    if (v && v.__proto__.constructor == Uint8Array) {
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
