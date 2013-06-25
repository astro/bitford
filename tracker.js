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
