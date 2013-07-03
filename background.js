chrome.app.runtime.onLaunched.addListener(function(launchData) {
    chrome.app.window.create('main.html', {
    	id: 'bitford_main'
    }, function(win) {
    	win.contentWindow.launchData = launchData;
    });
});

var torrents = [];

function loadTorrent(file, sendResponse) {
    var reader = new FileReader();
    reader.onload = function() {
	    var torrentMeta = BEnc.parse(reader.result);
	    console.log("meta", torrentMeta);
	    /* Calc infoHash */
	    var sha1 = new Digest.SHA1();
	    var infoParts = BEnc.encodeParts(torrentMeta.info);
	    infoParts.forEach(sha1.update.bind(sha1));
	    torrentMeta.infoHash = new Uint8Array(sha1.finalize());

	    var torrent = new Torrent(torrentMeta);
	    // TODO: infoHash collision?
	    torrents.push(torrent);
	    console.log("Torrents", Torrents);
	    sendResponse("");
    };
    reader.readAsArrayBuffer(file);
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    console.log("onMessage", msg, sender, sendResponse);
    if (msg.loadTorrent) {
	loadTorrent(msg.loadTorrent, sendResponse);
    }
});

var ports = [];
chrome.runtime.onConnect.addListener(function(port) {
    console.log("port connected", port);
    ports.push(port);
    port.onMessage.addListener(function(msg, sender, sendResponse) {
    });
    port.onDisconnect.addListener(function() {
	ports = ports.filter(function(port1) {
	    return port === port1;
	});
    });
});

