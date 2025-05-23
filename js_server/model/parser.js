/**
 * Constructs a LogParser to parse the provided raw log text.
 * 
 * @classdesc
 * 
 * <p>
 * LogParser can be used to transform raw log text to {@link LogEvent}s The
 * LogParser class per se is only responsible for dividing the raw text into
 * different executions according to the supplied delimiter. It then creates one
 * {@link ExecutionParser} for each execution to which to task for parsing is
 * then delegated.
 * </p>
 * 
 * <p>
 * The raw log potentially contains text for multiple executions. Delimiters
 * demarcate where one execution's text ends and another begins. Labels can be
 * given to executions by specifying a "trace" capture group within the
 * delimiter regex. (So the label text must be part of the delimiter). This
 * label can later be used to identify an execution. If an execution's text is
 * not preceeded by a delimiter, it is given the empty string as its label.
 * </p>
 * 
 * @constructor
 * @param {String} rawString the raw log text
 * @param {NamedRegExp} delimiter a regex that specifies the delimiter. Anything
 *            that matches the regex will be treated as a delimiter. A delimiter
 *            acts to separate different executions.
 * @param {NamedRegExp} regexp A regex that specifies the log parser. The parser
 *            must contain the named capture groups "clock", "event", and "host"
 *            representing the vector clock, the event string, and the host
 *            respectively.
 */
function LogParser(rawString, delimiter, regexp) {

    /** @private */
    this.rawString = rawString.trim();

    /** @private */
    this.delimiter = delimiter;

    /** @private */
    this.regexp = regexp;

    /** @private */
    this.labels = [];

    /** @private */
    this.executions = {};

    var names = this.regexp.getNames();
    if (!this.regexp.isZap() && (names.indexOf("clock") < 0 || names.indexOf("host") < 0 || names.indexOf("event") < 0)) {
        var e = new Exception("The parser RegExp you entered does not have the necessary named capture groups.\n", true);
        e.append("Please see the documentation for details.");
        throw e;
    }

    if (this.delimiter != null) {
        var currExecs = this.rawString.split(this.delimiter.no);
        var currLabels = [ "" ];

        if (this.delimiter.getNames().indexOf("trace") >= 0) {
            var match;
            while (match = this.delimiter.exec(this.rawString)) {
                currLabels.push(match.trace);
            }
        }

        for (var i = 0; i < currExecs.length; i++) {
            if (currExecs[i].trim().length > 0) {
                var currlabel = currLabels[i];
                if(this.executions[currlabel]) {
                    throw new Exception("Execution names must be unique. There are multiple executions called \"" + currlabel + "\"", true);
                }
                this.executions[currlabel] = new ExecutionParser(currExecs[i], currlabel, regexp);
                this.labels.push(currlabel);
            }
        }
    }
    else {
        this.labels.push("");
        this.executions[""] = new ExecutionParser(this.rawString, "", regexp);
    }
}

/**
 * Gets all of the labels of the executions. The ordering of labels in the
 * returned array is guaranteed to be the same as the order in which they are
 * encountered in the raw log text
 * 
 * @returns {Array<String>} An array of all the labels.
 */
LogParser.prototype.getLabels = function() {
    return this.labels.slice();
};

/**
 * Returns the {@link LogEvent}s parsed by this. The ordering of LogEvents in
 * the returned array is guaranteed to be the same as the order in which they
 * were encountered in the raw log text
 * 
 * @param {String} label The label of the execution you want to get log events
 *            from.
 * @returns {Array<LogEvent>} An array of LogEvents
 */
LogParser.prototype.getLogEvents = function(label) {
    if (!this.executions[label])
        return null;
    return this.executions[label].logEvents;
};

/**
 * @classdesc
 * 
 * ExecutionParser parses the raw text for one execution.
 * 
 * @constructor
 * @private
 * @param {String} rawString The raw string of the execution's log
 * @param {Label} label The label that should be associated with this execution
 * @param {NamedRegExp} regexp The RegExp parser
 */
function ExecutionParser(rawString, label, regexp) {

    /** @private */
    this.rawString = rawString;

    /** @private */
    this.label = label;

    /** @private */
    this.timestamps = [];

    /** @private */
    this.logEvents = [];

    if (regexp.isZap()) {
        console.log("parsing zap logs");
        parseZapLogs(this.timestamps, this.logEvents);

        if (this.logEvents.length == 0) {
            throw new Exception("The zap log file you entered does not capture any events for the execution " + label, true);
        }
        return
    }

    var match;
    while (match = regexp.exec(rawString)) {
        var newlines = rawString.substr(0, match.index).match(/\n/g);
        var ln = newlines ? newlines.length + 1 : 1;

        var clock = match.clock;
        var host = match.host;
        var event = match.event;

        var fields = {};
        regexp.getNames().forEach(function(name, i) {
            if (name == "clock" || name == "event")
                return;

            fields[name] = match[name];
        });

        var timestamp = parseStringTimestamp(clock, host, ln);
        this.timestamps.push(timestamp);
        this.logEvents.push(new LogEvent(event, timestamp, ln, fields));
    }

    if (this.logEvents.length == 0)
        throw new Exception("The parser RegExp you entered does not capture any events for the execution " + label, true);

    function parseStringTimestamp(clockString, hostString, line) {
        try {
            // Attempt to parse a clockString as plain JSON
            clock = JSON.parse(clockString);
        } catch (err1) {
            console.log("GOT ERR HERE", err1, clockString)
            try {
                // Corner-case, attempt to interpret as JSON escaped with quotes
                // Added to support TLA+ syntax: {\"w1\":1,\"w2\":1}
                clockString = clockString.replace(/\\\"/g, "\"")
                clock = JSON.parse(clockString);
            } catch (err2) {
                var exception = new Exception("An error occured while trying to parse the vector timestamp on line " + (line + 1) + ":");

                // Checks if clockString has a string value
                // if not, the error message is not user-friendly 
                // and we can't append it to the exception.
                var isUserFriendly = clockString ? true : false;
                if (isUserFriendly) {
                    exception.append(clockString, "code");
                }
                
                exception.append("The error message from the JSON parser reads:\n");
                exception.append(err2.toString(), "italic");
                exception.setUserFriendly(isUserFriendly);
                throw exception;
            }
        }
    
        return parseJsonTimestamp(clock, hostString)
    }

    function parseJsonTimestamp(clock, hostString, line) {
        try {
            var ret = new VectorTimestamp(clock, hostString);
            if (ret === undefined) {
                console.log("returning undefined timestamp?", clock, hostString, line);
            }
            return ret;
        }
        catch (exception) {
            console.log(exception, typeof exception)
            exception.prepend("An error occured while trying to parse the vector timestamp on line " + (line + 1) + ":\n\n");
            exception.append(JSON.stringify(clock), "code");
            exception.setUserFriendly(true);
            throw exception;
        }
    }

    function parseZapLogs(timestamps, logEvents) {
        // Split log data into individual lines
        // console.log("got here, raw string is", rawString)
        const encoder = new TextEncoder();
        let currentOffset = 0;
        const logLines = rawString.trim().split("\n");

        for (let lineNum = 0; lineNum < logLines.length; lineNum ++) {
            const line = logLines[lineNum];
            if (line === "") {
                currentOffset += encoder.encode('\n').length;
                continue;
            }
            const logObject = JSON.parse(line); // Parse JSON line

            const fields = {};

            const host = logObject.processId
            const event = logObject.message
            const clock = logObject.VCString

            // console.log(clock, lineNum)
            const convertVal = (val) => {
                if (val !== null && typeof val === 'object') {
                    return JSON.stringify(val, null, 2)
                }
                if (typeof val !== 'string') {
                    return val.toString()
                }
                return val
            }

            // console.log("Log Entry:");
            Object.entries(logObject).forEach(([key, value]) => {
                if (!['processId', 'message', 'VCString'].includes(key)) {
                    fields[convertVal(key)] = convertVal(value)
                }
                // console.log(`${key}:`, value);
                // if (!['processId', 'message', 'VCString'].includes(key)) {
                //     fields[key] = value
                // }
                // if (key === 'stacktrace') {
                //     console.log('stackstrace');
                //     console.log(JSON.stringify(value))
                // }
            });

            var timestamp = parseJsonTimestamp(clock, host, line);
            timestamps.push(timestamp);
            // if (line.includes(event))
            logEvents.push(new LogEvent(event, timestamp, lineNum, fields, line, currentOffset));
            currentOffset += encoder.encode(line + '\n').length;
        }
    }

}
