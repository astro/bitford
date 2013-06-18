chrome.app.runtime.onLaunched.addListener(function(launchData) {
    chrome.fileSystem.chooseEntry({
	type: 'openFile',
	accepts: [{
	    description: "BitTorrent metainfo file",
	    mimeTypes: ["application/x-bittorrent"],
	    extensions: ["torrent"]
	}]
    }, function() {
    });
    chrome.app.window.create('main.html', {
	id: "main",
	bounds: {
	    width: 640,
	    height: 400
	}
    });
    console.log("onLaunched", launchData);
});
