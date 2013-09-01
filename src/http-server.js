function createHTTPServer(cb, listenCb) {
    tryCreateTCPServer(8000, function(sock) {
	console.log("new http server sock", sock);
	new HTTPServer(sock, cb);
    }, listenCb);
}

function HTTPServer(sock, cb) {
    this.sock = sock;
    this.cb = cb;
    sock.onData = this.processData.bind(this);
    sock.onDrain = this.onDrain.bind(this);
    sock.resume();
    // TODO: request timeout
    this.buffer = new BufferList();
    this.state = 'request';
    this.currentRes = null;
}

HTTPServer.prototype = {
    processData: function(data) {
	if (data.byteLength < 1)
	    return;
	this.buffer.append(data);
	// TODO: limit length per request

	for(var i = this.buffer.length - data.byteLength; i < this.buffer.length; i++) {
	    if (this.buffer.getByte(i) === 10) {
		var line = UTF8ArrToStr(new Uint8Array(this.buffer.slice(0, i))).replace(/\r$/, "");
		this.processLine(line);
		this.buffer.take(i + 1);
		i = 0;
	    }
	}
    },

    processLine: function(line) {
	var m;
	switch(this.state) {
	    case 'request':
		if ((m = line.match(/^([A-Z]+) (\/[^\s]*) HTTP\/([\d.]+)$/))) {
		    this.method = m[1];
		    this.path = m[2];
		    this.httpVersion = m[3];
		    this.state = 'headers';
		    this.headers = {};
		} else {
		    throw 'up';
		}
		break;
	    case 'headers':
		if (line === "") {
		    this.state = 'body';
		    this.sock.pause();
		    this.onRequest();
		} else if ((m = line.match(/^(.+): (.*)/)))
		    this.headers[m[1]] = m[2];
		break;
	    default:
		throw 'up';
	}
    },

    onRequest: function() {
	console.log("HTTP req", this.method, this.path, this.httpVersion, this.headers);
	var req = {
	    method: this.method,
	    path: this.path,
	    httpVersion: this.httpVersion,
	    headers: this.headers
	};
	var contentLength;
	var res = {
	    writeHead: function(status, reason, headers) {
		if (headers.hasOwnProperty("Content-Length")) {
		    contentLength = parseInt(headers["Content-Length"], 10);
		} else {
		    headers['Transfer-Encoding'] = 'chunked';
		}
		this.writeHead(status, reason, headers);
	    }.bind(this),
	    write: function(data) {
		if (typeof contentLength == 'number') {
		    /* With Content-Length: */
		    this.sock.write(data);
		    contentLength -= data.byteLength;
		} else {
		    /* Chunked Transfer-Encoding */
		    if (data.byteLength > 0) {
			this.sock.write(data.byteLength.toString(16) + "\r\n");
			this.sock.write(data);
			this.sock.write("\r\n");
		    }
		}
	    }.bind(this),
	    end: function() {
		if (typeof contentLength != 'number')
		    this.sock.write("0\r\n\r\n");
		this.sock.end();
		this.currentRes = null;
	    }.bind(this),
	    onDrain: null
	};
	this.currentRes = res;
	this.cb(req, res);
    },

    writeHead: function(status, reason, headers) {
	headers['Connection'] = 'close';

	var lines = ["HTTP/1.0 " + status + " " + reason];
	for(var k in headers)
	    if (headers.hasOwnProperty(k))
		lines.push(k + ": " + headers[k]);
	lines.push("");
	lines.push("");
	this.sock.write(lines.join("\r\n"));
    },

    onDrain: function() {
	if (this.currentRes && this.currentRes.onDrain)
	    this.currentRes.onDrain();
    }
};