chrome.app.runtime.onLaunched.addListener(function(launchData) {
    chrome.app.window.create('../ui/main.html', {
    	id: 'bitford_main'
    }, function(win) {
    });

    if (launchData &&
	launchData.type === "application/x-bittorrent" &&
	launchData.data)
	loadTorrent(launchData.data);
});

/**
 * API
 */
var torrents = [];

function addTorrent(binary) {
    var torrentMeta = BEnc.parse(binary);
    console.log("meta", torrentMeta);
    /* Calc infoHash */
    var sha1 = new Digest.SHA1();
    var infoParts = BEnc.encodeParts(torrentMeta.info);
    infoParts.forEach(sha1.update.bind(sha1));
    torrentMeta.infoHash = new Uint8Array(sha1.finalize());

    var torrent = new Torrent(torrentMeta);
    // TODO: infoHash collision?
    torrents.push(torrent);

    if (sessionTx)
	sessionTx("readwrite", 'torrents', function(objectStore) {
	    objectStore.put(binary, bufferToHex(torrentMeta.infoHash));
	});
}

function loadTorrent(file) {
    var reader = new FileReader();
    reader.onload = function() {
	addTorrent(reader.result);
    };
    reader.readAsArrayBuffer(file);
}

function rmTorrent(torrent) {
    torrent.end();
    console.log("filtering");
    torrents = torrents.filter(function(torrent1) {
	return torrent !== torrent1;
    });
    if (sessionTx)
	sessionTx("readwrite", 'torrents', function(objectStore) {
	    objectStore.delete(bufferToHex(torrent.infoHash));
	});
    console.log("removed");
}

/**
 * Session handling
 */
var sessionTx = function() {};

function openSession(cb) {
    var req = indexedDB.open("bitford-session", 2);
    req.onerror = function() {
	console.error("indexedDB", arguments);
    };
    req.onupgradeneeded = function(event) {
	var db = event.target.result;
	db.createObjectStore('torrents');
	db.createObjectStore('settings');
    };
    req.onsuccess = function(event) {
	var db = event.target.result;
	if (!db)
	    throw "No DB";

	cb(db);
    }.bind(this);
}

function restoreSession(cb) {
    sessionTx("readonly", 'torrents', function(objectStore) {
	var req = objectStore.openCursor(
	    IDBKeyRange.lowerBound(""),
	    'next'
	);
	req.onsuccess = function(event) {
	    var cursor = event.target.result;
	    if (cursor) {
		addTorrent(cursor.value);
		cursor.continue();
	    }
	};
	req.onerror = function(e) {
	    console.error("cursor", e);
	};
    }, cb);
}

function loadSessionSettings() {
    if (!sessionTx)
	return;

    sessionTx("readonly", 'settings', function(objectStore) {
	var req1 = objectStore.get("upShaperRate");
	req1.onsuccess = function() {
	    if (typeof req1.result === 'number')
		upShaperRate.rate = req1.result;
	};

	var req2 = objectStore.get("downShaperRate");
	req2.onsuccess = function() {
	    if (typeof req2.result === 'number')
		downShaperRate.rate = req2.result;
	};
    });
}

/* Called when changing shapers */
function saveSessionSettings() {
    if (!sessionTx)
	return;

    sessionTx("readwrite", 'settings', function(objectStore) {
	objectStore.put(upShaperRate.rate, "upShaperRate");
	objectStore.put(downShaperRate.rate, "downShaperRate");
    });
}

openSession(function(db) {
    sessionTx = function(mode, storeName, cb, finalCb) {
	var tx = db.transaction([storeName], mode);
	tx.onerror = function(e) {
	    console.error("store tx", e);
	    if (finalCb)
		finalCb(e);
	};
	tx.oncomplete = function() {
	    if (finalCb)
		finalCb();
	};
	cb(tx.objectStore(storeName));
    };

    loadSessionSettings();
    restoreSession(function() {
	/* reclaim storage */
	reclaimStorage(torrents.map(function(torrent) {
	    return torrent.infoHash;
	}), function(totalReclaimed) {
	    console.log("Reclaimed", totalReclaimed, "bytes of stale data");
	});
    });
});


/* Peer listener */
var peerPort;

tryCreateTCPServer(6881, function(sock) {
    console.log("new peer server sock", sock);
    servePeer(sock, function(peer) {
	for(var i = 0; i < torrents.length; i++) {
	    if (bufferEq(peer.infoHash, torrents[i].infoHash))
		break;
	}
	if (i < torrents.length) {
	    torrents[i].peers.push(peer);
	    peer.torrent = torrents[i];
	} else {
	    console.error("incoming", peer.ip, "unknown torrent", peer.infoHash);
            peer.end();
	}
    });
}, function(err, port) {
    if (port)
	peerPort = port;
});
