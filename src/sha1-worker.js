importScripts("../lib/digest.js");

var sha1s = {};

var onmessage = function(ev) {
    var update = ev.data.update,
	finalize = ev.data.finalize;

    if (update) {
	if (!sha1s.hasOwnProperty(update.index))
	    sha1s[update.index] = new Digest.SHA1();
	sha1s[update.index].update(update.data);
	// for back-pressure
	postMessage({ });
    } else if (finalize && sha1s.hasOwnProperty(finalize.index)) {
	var hash = sha1s[finalize.index].finalize();
	delete sha1s[finalize.index];
	postMessage({ hash: hash }, [hash]);
    } else if (finalize) {
	if (console)
	    console.error("sha1-worker: finalizing non-existing " + finalize.index);
	var hash = new Uint8Array(20);  // dummy
	postMessage({ hash: hash }, [hash]);
    }
};
