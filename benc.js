(function() {

var CHAR_CODES = {
    l: "l".charCodeAt(0),
    e: "e".charCodeAt(0),
    d: "d".charCodeAt(0),
    i: "i".charCodeAt(0),
    0: "0".charCodeAt(0),
    9: "9".charCodeAt(0),
    colon: ":".charCodeAt(0)
};

function parse_(s) {
    var i, result;
    switch(s[0]) {
	case CHAR_CODES.l:
	    result = [];
	    var e = { rest: s.subarray(1) };
	    while(e.rest[0] != CHAR_CODES.e) {
		e = parse_(e.rest);
		result.push(e.data);
	    }
	    return { data: result,
		     rest: e.rest.subarray(1) };
	case CHAR_CODES.d:
	    result = {};
	    var k, v = { rest: s.subarray(1) };
	    while(v.rest[0] != CHAR_CODES.e) {
		k = parse_(v.rest);
		v = parse_(k.rest);
		// FIXME: toString()?
		result[UTF8ArrToStr(k.data)] = v.data;
	    }
	    return { data: result,
		     rest: v.rest.subarray(1) };
	    break;
	case CHAR_CODES.i:
	    var number = "";
	    for(i = 1; s[i] != CHAR_CODES.e && i < s.length; i++)
		number += String.fromCharCode(s[i]);

	    return { data: parseInt(number, 10),
		     rest: s.subarray(i + 1) };
	default:
	    if (s[0] >= CHAR_CODES[0] && s[0] <= CHAR_CODES[9]) {
		var len = String.fromCharCode(s[0]);
		for(i = 1; s[i] != CHAR_CODES.colon && i < s.length; i++)
		    len += String.fromCharCode(s[i]);
		len = parseInt(len, 10);
		var str = s.subarray(i + 1, i + 1 + len);
		return { data: new Uint8Array(str),
			 rest: s.subarray(i + 1 + len) };
	    } else
		throw new Error("BEncoding parse error");
    }
}

function encodeToBlobParts(x) {
    var result = [];
    function walk(x) {
        switch(x.constructor) {
        case Object:
            result.push("d");
            Object.keys(x).sort().forEach(function(k) {
                if (x.hasOwnProperty(k)) {
                    walk(k);
                    walk(x[k]);
                }
            });
            result.push("e");
            break;
        case Array:
            result.push("l");
            x.forEach(walk);
            result.push("e");
            break;
        case Number:
            result.push("i", Math.floor(x).toString(), "e");
            break;
        default:
            if (x.constructor === String)
                x = strToUTF8Arr(x);
            result.push(x.byteLength.toString(), ":", x);
        }
    }
    walk(x);
    return result;
}


window.BEnc = {
    parse: function parse(data) {
	if (data.__proto__.constructor === ArrayBuffer)
	    data = new Uint8Array(data);
	if (data.__proto__.constructor !== Uint8Array)
	    throw new Error("Parse expects Uint8Array");
	console.log("parse", data);
	return parse_(data).data;
    },

    encodeParts: encodeToBlobParts,

    encodeBlob: function(val) {
	return new Blob(encodeToBlobParts(val));
    }
};

})();