// Worker Child Process Handler for pixl-server-pool
// Spawned via worker_proxy.js, runs in separate process
// Copyright (c) 2017 - 2020 Joseph Huckaby
// Released under the MIT License

var Path = require('path');
var zlib = require('zlib');
var Perf = require('pixl-perf');
var BinaryStream = require('./stream.js');

// catch SIGINT and ignore (parent handles these)
process.on('SIGINT', function() {});

var worker = {
	
	config: null,
	user_obj: null,
	num_active_requests: 0,
	request_maint: false,
	request_shutdown: false,
	uriHandlers: [],
	
	run: function() {
		// startup child process
		var self = this;
		
		// setup two-way msgpack communication over stdio
		this.encodeStream = BinaryStream.createEncodeStream();
		this.encodeStream.pipe( process.stdout );
		
		this.decodeStream = BinaryStream.createDecodeStream();
		process.stdin.pipe( this.decodeStream );
		
		this.decodeStream.on('data', this.receiveCommand.bind(this));
		
		process.on('SIGTERM', function() {
			// caught SIGTERM, which means the parent crashed
			var err = new Error("Caught SIGTERM: Emergency Pool Shutdown");
			err.code = 'SIGTERM';
			self.emergencyShutdown( err );
			process.exit(1);
		});
	},
	
	receiveCommand: function(req) {
		// receive data packet from parent
		switch (req.cmd) {
			case 'startup':
				for (var key in req) {
					if (key != 'cmd') this[key] = req[key];
				}
				this.startup();
			break;
			
			case 'request':
			case 'custom':
				this.handleRequest(req);
			break;
			
			case 'maint':
				this.maint(req.data || true);
			break;
			
			case 'message':
				this.handleMessage(req);
			break;
			
			case 'shutdown':
				this.shutdown();
			break;
		}
	},
	
	startup: function() {
		// load user code and allow it to startup async
		var self = this;
		
		// optionally compress text content in the worker
		this.compEnabled = this.config.compress_child || this.config.gzip_child || false;
		this.compRegex = new RegExp( this.config.compress_regex || this.config.gzip_regex || '.+', "i" );
		this.gzipOpts = this.config.gzip_opts || {
			level: zlib.constants.Z_DEFAULT_COMPRESSION, 
			memLevel: 8 
		};
		
		this.brotliEnabled = !!zlib.BrotliCompress && this.config.brotli_child;
		this.brotliOpts = this.config.brotli_opts || {
			chunkSize: 16 * 1024,
			mode: 'text',
			level: 4
		};
		
		if (this.brotliEnabled) {
			if ("mode" in this.brotliOpts) {
				switch (this.brotliOpts.mode) {
					case 'text': this.brotliOpts.mode = zlib.constants.BROTLI_MODE_TEXT; break;
					case 'font': this.brotliOpts.mode = zlib.constants.BROTLI_MODE_FONT; break;
					case 'generic': this.brotliOpts.mode = zlib.constants.BROTLI_MODE_GENERIC; break;
				}
				if (!this.brotliOpts.params) this.brotliOpts.params = {};
				this.brotliOpts.params[ zlib.constants.BROTLI_PARAM_MODE ] = this.brotliOpts.mode;
				delete this.brotliOpts.mode;
			}
			if ("level" in this.brotliOpts) {
				if (!this.brotliOpts.params) this.brotliOpts.params = {};
				this.brotliOpts.params[ zlib.constants.BROTLI_PARAM_QUALITY ] = this.brotliOpts.level;
				delete this.brotliOpts.level;
			}
			if ("hint" in this.brotliOpts) {
				if (!this.brotliOpts.params) this.brotliOpts.params = {};
				this.brotliOpts.params[ zlib.constants.BROTLI_PARAM_SIZE_HINT ] = this.brotliOpts.hint;
				delete this.brotliOpts.hint;
			}
		} // brotli
		
		this.acceptEncodingMatch = this.brotliEnabled ? /\b(gzip|deflate|br)\b/i : /\b(gzip|deflate)\b/i;
		
		// optionally listen for uncaught exceptions and shutdown
		if (this.server.uncatch) {
			require('uncatch').on('uncaughtException', function(err) {
				self.emergencyShutdown(err);
			});
		}
		
		// load user module
		this.user_obj = require(
			this.config.script.match(/^\//) ? this.config.script : Path.join(process.cwd(), this.config.script) 
		);
		
		// call user startup
		if (this.user_obj.startup) {
			this.user_obj.startup( this, function(err) {
				if (err) throw err;
				else self.sendCommand('startup_complete');
			} );
		}
		else this.sendCommand('startup_complete');
	},
	
	handleRequest: function(req) {
		// handle new incoming web request
		var self = this;
		var handler = null;
		
		// track active requests (for maint and shutdown)
		this.num_active_requests++;
		
		// track perf in child
		req.perf = new Perf();
		req.perf.begin();
		
		// prepare response, which child can modify
		var res = {
			id: req.id,
			status: "200 OK",
			type: 'string',
			headers: {},
			body: ''
		};
		req.response = res;
		
		// include mock request & socket & perf objects, to be more pixl-server-web compatible
		if (req.cmd == 'request') {
			req.request = {
				httpVersion: req.httpVersion,
				headers: req.headers,
				method: req.method,
				url: req.uri,
				socket: { remoteAddress: req.ip }
			};
			
			// decide if we need to call a custom URI handler or not
			var uri = req.request.url.replace(/\?.*$/, '');
			
			for (var idx = 0, len = this.uriHandlers.length; idx < len; idx++) {
				var matches = uri.match(this.uriHandlers[idx].regexp);
				if (matches) {
					req.matches = matches;
					handler = this.uriHandlers[idx];
					idx = len;
				}
			}
		} // request cmd
		
		// finish response and send to stdio pipe
		var finishResponse = function() {
			// copy perf metrics over to res
			if (!res.perf) res.perf = req.perf.metrics();
			
			// send response to parent
			self.sendCommand('response', res);
			
			// done with this request
			self.num_active_requests--;
			
			// if we're idle now, check for pending maint / shutdown requests
			if (!self.num_active_requests) {
				if (self.request_shutdown) self.shutdown();
				else if (self.request_maint) self.maint(self.request_maint);
			}
		};
		
		// handle response back from user obj
		var handleResponse = function() {
			// check for error as solo arg
			if ((arguments.length == 1) && (arguments[0] instanceof Error)) {
				res.status = "500 Internal Server Error";
				res.type = "string";
				res.body = "" + arguments[0];
				res.logError = {
					code: 500,
					msg: res.body
				};
			}
			else if (req.cmd == 'custom') {
				// custom request, pass body through
				res.type = 'passthrough';
				res.body = arguments[1] || res.body;
			}
			else {
				// check for pixl-server-web style callbacks
				if ((arguments.length == 1) && (typeof(arguments[0]) == 'object')) {
					// json
					res.body = arguments[0];
				}
				else if ((arguments.length == 3) && (typeof(arguments[0]) == "string")) {
					// status, headers, body
					res.status = arguments[0];
					res.headers = arguments[1] || {};
					res.body = arguments[2];
				}
				
				// set res type and massage body if needed
				if (res.body && (res.body instanceof Buffer)) {
					// buffers survive msgpack
					res.type = 'buffer';
				}
				else if (res.body && (typeof(res.body) == 'object')) {
					res.type = 'string';
					
					// stringify JSON here
					var json_raw = (req.query && req.query.pretty) ? JSON.stringify(res.body, null, "\t") : JSON.stringify(res.body);
					if (req.query && req.query.callback) {
						// JSONP
						res.body = req.query.callback + '(' + json_raw + ");\n";
						if (!res.headers['Content-Type']) res.headers['Content-Type'] = "text/javascript";
					}
					else {
						// pure JSON
						res.body = json_raw;
						if (!res.headers['Content-Type']) res.headers['Content-Type'] = "application/json";
					}
				}
			}
			
			// optional compress inside worker process
			if (
				self.compEnabled &&
				(res.status == '200 OK') && (res.type == 'string') &&
				res.body && res.body.length && req.headers && res.headers &&
				!res.headers['Content-Encoding'] && 
				(res.headers['Content-Type'] && res.headers['Content-Type'].match(self.compRegex)) && 
				(req.headers['accept-encoding'] && req.headers['accept-encoding'].match(self.acceptEncodingMatch))
			) 
			{
				// okay to compress!
				req.perf.begin('compress');
				
				var zlib_opts = null;
				var zlib_func = '';
				var accept_encoding = req.headers['accept-encoding'].toLowerCase();
				
				if (self.brotliEnabled && accept_encoding.match(/\b(br)\b/)) {
					// prefer brotli first, if supported by Node.js
					zlib_func = 'brotliCompress';
					zlib_opts = self.brotliOpts || {};
					res.headers['Content-Encoding'] = 'br';
				}
				else if (accept_encoding.match(/\b(gzip)\b/)) {
					// prefer gzip second
					zlib_func = 'gzip';
					zlib_opts = self.gzipOpts || {};
					res.headers['Content-Encoding'] = 'gzip';
				}
				else if (accept_encoding.match(/\b(deflate)\b/)) {
					// prefer deflate third
					zlib_func = 'deflate';
					zlib_opts = self.gzipOpts || {}; // yes, same opts as gzip
					res.headers['Content-Encoding'] = 'deflate';
				}
				
				zlib[ zlib_func ]( res.body, zlib_opts, function(err, data) {
					req.perf.end('compress');
					
					if (err) {
						// should never happen
						res.status = "500 Internal Server Error";
						res.body = "Failed to compress content: " + err;
						res.logError = {
							code: 500,
							msg: res.body
						};
					}
					else {
						// no error, send as buffer (msgpack)
						res.type = 'buffer';
						res.body = data;
					}
					
					finishResponse();
				}); // compress
			}
			else {
				// no compress
				finishResponse();
			}
		}; // handleResponse
		
		// call custom URI handler, or the generic user_obj.handler()
		if (handler) handler.callback( req, handleResponse );
		else if (req.cmd == 'custom') this.user_obj.custom( req, handleResponse );
		else this.user_obj.handler( req, handleResponse );
	},
	
	handleMessage: function(req) {
		// received custom message from server
		if (this.user_obj.message) {
			this.user_obj.message( req.data );
		}
	},
	
	maint: function(user_data) {
		// perform routine maintenance
		var self = this;
		
		// make sure no requests are active
		if (this.num_active_requests) {
			this.request_maint = user_data || true;
			return;
		}
		this.request_maint = false;
		
		if (this.user_obj.maint) {
			// user has a maint() function, so call that
			this.user_obj.maint( user_data, function(err) {
				if (err) throw err;
				else self.sendCommand('maint_complete');
			} );
		}
		else if (global.gc) {
			// no user handler, so default to collecting garbage
			global.gc();
			this.sendCommand('maint_complete');
		}
		else {
			// nothing to do
			this.sendCommand('maint_complete');
		}
	},
	
	sendCommand: function(cmd, data) {
		// send command back to parent
		if (!data) data = {};
		data.cmd = cmd;
		this.encodeStream.write(data);
	},
	
	sendMessage: function(data) {
		// send custom user message
		// separate out user data to avoid any chance of namespace collision
		this.sendCommand('message', { data: data });
	},
	
	addURIHandler: function(uri, name, callback) {
		// add custom handler for URI
		var self = this;
		
		if (typeof(uri) == 'string') {
			uri = new RegExp("^" + uri + "$");
		}
		
		this.uriHandlers.push({
			regexp: uri,
			name: name,
			callback: callback
		});
	},
	
	removeURIHandler: function(name) {
		// remove handler for URI given name
		this.uriHandlers = this.uriHandlers.filter( function(item) {
			return( item.name != name );
		} );
	},
	
	shutdown: function() {
		// exit child process when we're idle
		if (this.num_active_requests) {
			this.request_shutdown = true;
			return;
		}
		this.request_shutdown = false;
		
		// close encode stream
		this.encodeStream.end();
		
		// allow user code to run its own async shutdown routine
		if (this.user_obj.shutdown) {
			this.user_obj.shutdown( function() {
				process.exit(0);
			} );
		}
		else {
			process.exit(0);
		}
	},
	
	emergencyShutdown: function(err) {
		// emergency shutdown, due to crash
		if (this.user_obj && this.user_obj.emergencyShutdown) {
			this.user_obj.emergencyShutdown(err);
		}
		else if (this.user_obj && this.user_obj.shutdown) {
			this.user_obj.shutdown( function() { /* no-op */ } );
		}
		// Note: not calling process.exit here, because uncatch does it for us
	}
};

// redirect console._stdout, as it will interfere with msgpack
console._stdout = console._stderr;

worker.run();
