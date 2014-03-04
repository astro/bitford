var MIME_TYPES = {
    "mp4": "video/mp4",
    "m4v": "video/mp4",
    "mov": "video/mp4",
    "webm": "video/webm",
    "ogv": "video/ogg",
    "mkv": "video/webm",
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "aac": "audio/aac",
    "m4a": "audio/mp4",
    "m4b": "audio/mp4",
    "3gp": "audio/3gpp",
    "ogg": "audio/ogg",
    "oga": "audio/ogg",
    "opus": "audio/opus",
    "gif": "image/gif",
    "jpg": "image/jpeg",
    "png": "image/png",
    "html": "text/html"
};

function getMimeType(path) {
    if (typeof path !== 'string')
	path = path[path.length - 1];

    var ps = (path + "").split(".");
    var result = MIME_TYPES[ps[ps.length - 1].toLowerCase()];
    return result || "application/octet-stream";
}
