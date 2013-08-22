function RateShaper(rate) {
    this.rate = rate;
    this.nextTick = Date.now();
}

RateShaper.prototype = {
    enqueue: function(item) {
	if (this.rate)
	    this.nextTick += 1000 * item.amount / this.rate;
	else
	    this.nextTick = 0;
	var now = Date.now(),
	    wait = Math.ceil(this.nextTick - now);

	if (wait <= 0) {
	    this.nextTick = now;
	    item.cb();
	} else {
	    setTimeout(item.cb, wait);
	}
    }
};

/* Shaper setup */
var upShaperRate = new RateShaper(102400);
var upShaper = {
    enqueue: upShaperRate.enqueue.bind(upShaperRate)
};

var downShaperRate = new RateShaper(1024 * 1024);
var downShaper = {
    enqueue: downShaperRate.enqueue.bind(downShaperRate)
};
