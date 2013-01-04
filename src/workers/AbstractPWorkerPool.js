// TODO: Pull out a common base class or mixin for this and AbstractRunnerPool
// to share.
var regDoc = "register: function(name, func, [promise=true] [, async=false] [, interleave=false])";
function AbstractPWorkerPool(url, taskQueue, minWorkers, maxWorkers) {
	this._url = url;
	this._queue = taskQueue;
	this._minWorkers = minWorkers;
	this._maxWorkers = maxWorkers;
	this._runningWorkers = new LinkedList();
	this._idleWorkers = new LinkedList();

	this._workerCreated = this._workerCreated.bind(this);
	for (var i = 0; i < minWorkers; ++i) {
		var worker = this._createWorker(this._workerCreated);
	}
}

AbstractPWorkerPool.prototype = {
	_createWorker: function(cb) {
		var worker = new PromisingWorker(this._url)
		worker.ready(cb);
	},

	_workerCreated: function(worker, err) {
		if (err) {
			console.log(this._url + ": Error adding worker.")
			console.log(err);
		} else {
			if (!this.fns) {
				this._createFns(worker);
			}
			this._idleWorkers.add(worker);
		}
	},

	_createFns: function(worker) {
		this.fns = {};

		var self = this;
		for (var fname in worker.fns) {
			var registration = worker.registrations[fname];
			this.fns[fname] = (function(registration, fname) {
				return function() {
					self._submit(worker.fns[fname], registration, arguments);
				};
			})(registration, fname);
		}
	},

	_submit: function(fn, registration, args) {
		if (!registration.promise) {
			throw this._url + ": All functions used in a PWorkerPool must return" +
			" a promise.  Check your function registration. " + regDoc;
		}

		var task = {
			fn: fn,
			registration: registration,
			args: args
		};

		var result = null;
		var worker = null;
		if (this._idleWorkers.size() > 0) {
			worker = this._idleWorkers.remove().value;
			var promise = this._dispatchToWorker(worker, task);
			if (registration.interleave)
				this._idleWorkers.add(worker);
			result = promise;
		} else if (this._runningWorkers.size() < this._maxWorkers) {
			var promise = new Promise();
			var self = this;
			this._createWorker(function(newWorker, err) {
				worker = newWorker;
				if (err) {
					console.log(this._url + ": Error adding worker.")
					console.log(err);
				} else {
					task.promise = promise;
					self._dispatchToWorker(worker, task);
					if (registration.interleave)
						self._idleWorkers.add(worker);
				}
			});
			result = promise;
		} else {
			if (this._queue.full()) {
				throw 'Task queue has reached its limit';
			}

			task.promise = new Promise();
			this._queue.add(task);

			result = task.promise;
		}

		var self = this;
		result.always(function() {
			self._workerCompleted(worker, registration);
		});
	},

	_workerCompleted: function(worker, registration) {
		if (this._queue.size() > 0) {
			var task = this._queue.remove().value;
			var promise = this._dispatchToWorker(worker, task);
		} else {
			if (worker.runningNode) {
				this._runningWorkers.removeWithNode(worker.runningNode);
				worker.runningNode = null;
				// Push front to keep interleavers at a low priority.
				this._idleWorkers.pushFront(worker);
			} // TODO check reg for interleave?
			else {
				// This is an interleaver.
				// Move to the back of the idle worker list.
			}
		}
	},

	numWorkers: function() {
		return this._idleWorkers.size() + this._runningWorkers.size();
	},

	queueSize: function() {
		return this._queue.size();
	},

	_dispatchToWorker: function(worker, task) {
		worker.runningNode = this._runningWorkers.add(worker);
		var promise = task.fn.apply({
			__promise: task.promise
		}, args);

		return promise;
	},

	terminate: function() {
		this._queue.clear();
		this._runningWorkers.forEach(function(worker) {
			worker.terminate();
		}, this);

		this._idleWorkers.forEach(function(worker) {
			worker.terminate();
		}, this);

		this._runningWorkers.clear();
		this._idleWorkers.clear();
		this._terminated = true;
	}
};
