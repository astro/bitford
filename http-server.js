function createHTTPServer(port, cb) {
    createTCPServer("::", 8080, function(sock) {
	new HTTPServer(sock, cb);
    });
}

function HTTPServer(sock, cb) {
    this.sock = sock;
    this.cb = cb;
    sock.onData = this.processData.bind(this);
    // TODO: request timeout
    this.buffer = new BufferList();
    this.state = 'request';
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
	var res = {
	    writeHead: this.writeHead.bind(this),
	    write: function(data) {
		console.log("byteLength", data.byteLength, data.byteLength.toString(16));
		this.sock.write(data.byteLength.toString(16) + "\r\n");
		this.sock.write(data);
		this.sock.write("\r\n");
		// TODO: flow control
	    }.bind(this),
	    end: function() {
		this.sock.write("0\r\n\r\n");
		this.sock.end();
	    }.bind(this)
	};
	this.cb(req, res);
    },

    writeHead: function(status, reason, headers) {
	headers['Transfer-Encoding'] = 'chunked';
	headers['Connection'] = 'close';

	var lines = ["HTTP/1.0 " + status + " " + reason];
	for(var k in headers)
	    if (headers.hasOwnProperty(k))
		lines.push(k + ": " + headers[k]);
	lines.push("");
	lines.push("");
	this.sock.write(lines.join("\r\n"));
    }
};