chrome.app.runtime.onLaunched.addListener(function(launchData) {
    chrome.app.window.create('main.html', {
	id: "main",
	bounds: {
	    width: 640,
	    height: 400
	}
    });
    console.log("onLaunched", launchData);
});
