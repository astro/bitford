function RateShaper(rate) {
    this.rate = rate;
    this.nextTick = Date.now();
}

RateShaper.prototype = {
    enqueue: function(item) {
	this.nextTick += 1000 * item.amount / this.rate;
	var now = Date.now();

	if (this.nextTick <= now) {
	    this.nextTick = now;
	    item.cb();
	} else {
	    console.log("wait", Math.floor(this.nextTick - now));
	    setTimeout(item.cb, Math.floor(this.nextTick - now));
	}
    }
};

/* Shaper setup */
var rateShaper = new RateShaper(102400);
var shaper = {
    enqueue: rateShaper.enqueue.bind(rateShaper)
};
