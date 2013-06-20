var Socket = chrome.socket || chrome.experimental.socket;

function createTCPServer(host, port, cb) {
    if (!cb) {
	// Shift args
	cb = port;
	port = host;
	host = "::";
    }
    var backlog = 1;

    Socket.create('tcp', {}, function(createInfo) {
	var sockId = createInfo.socketId;
	Socket.listen(sockId, host, port, backlog, function(res) {
	    Socket.accept(sockId, function(acceptInfo) {
		var sockId = acceptInfo.socketId;
		if (sockId)
		    var sock = new TCPSocket(sockId);
		    cb(sock);
		    sock.read();
	    });
	});
    });
}

function connectTCP(host, port, cb) {
    Socket.create('tcp', {}, function(createInfo) {
	var sockId = createInfo.socketId;
	var sock = new TCPSocket(sockId);
	sock.connect(host, port, function(err) {
	    cb(err, err ? null : sock);
	    if (sock)
		sock.read();
	});
    });
}

/* TODO: use an event emitter */
function TCPSocket(sockId) {
    this.sockId = sockId;
    this.writesPending = 0;
}

TCPSocket.prototype = {
    connect: function(host, port, cb) {
	chrome.socket.connect(this.sockId, host, port, function(res) {
	    if (res === 0)
		cb(null);
	    else
		cb(new Error("Connect: " + res));
	});
    },

    read: function() {
	Socket.read(this.sockId, function(readInfo) {
	    if (readInfo.resultCode < 0)
		return this.end();
	    if (readInfo.data && this.onData) {
		this.onData(readInfo.data);
		this.read();
	    }
	}.bind(this));
    },
    write: function(data) {
	Socket.write(this.sockId, data.buffer, function(writeInfo) {
	    this.writesPending--;
	    if (this.onDrain)
		this.onDrain();
	}.bind(this));
	this.writesPending++;
    },
    end: function() {
	if (!this.sockId)
	    return;

	if (this.onEnd)
	    this.onEnd();
	Socket.disconnect(this.sockId);
	Socket.destroy(this.sockId);

	delete this.sockId;
    }
};

createTCPServer(6667, function(sock) {
    console.log("TCP", sock);
    sock.write("Hello");
});
