chrome.app.runtime.onLaunched.addListener(function(launchData) {
    chrome.app.window.create('main.html', {
    	id: 'bitford_main'
    }, function(win) {
    	win.contentWindow.launchData = launchData;
    });
});
