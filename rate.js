function RateEstimator() {
    this.data = [];
    this.rate = 0;
}

RateEstimator.prototype = {
    interval: 5000,

    clean: function() {
	var now = Date.now();
	while(this.data[0] && this.data[0].time < now - this.interval)
	    this.data.shift();
    },

    add: function(amount) {
	var now = Date.now();
	this.data.push({
	    time: now,
	    amount: amount
	});

	this.clean();
    },

    getRate: function() {
	this.clean();

	var now = Date.now();
	var first = this.data[0] && this.data[0].time;
	if (!first || first == now)
	    first = now - this.interval;

	var total = 0;
	for(var i = 0; i < this.data.length; i++)
	    total += this.data[i].amount;
	return 1000 * total / (now - first);
    }
};
