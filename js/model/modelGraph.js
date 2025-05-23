/**
 * Constructs a ModelGraph from an array of {@link LogEvent}s
 * 
 * @classdesc
 * 
 * A ModelGraph models a set of LogEvents as a graph. The graph is generated
 * based on the LogEvents passed to the constructor. One ModelNode is created
 * for each LogEvent The "ordering" of ModelNodes and the hosts to which they
 * belong is based on the natural ordering of the LogEvents.
 * 
 * @constructor
 * @extends AbstractGraph
 * @param {Array<LogEvent>} logEvents The array of LogEvents from which to
 *            generate the model.
 */
function ModelGraph(logEvents) {

    /**
     * @public
     * @type { Set<ModelNode> }
     * Set of nodes to observe with an intersection observer,
     * to know when to ask the server for more events
     */
    this.nodesToObserve = new Set();

    AbstractGraph.call(this);

    // Dictionary linking host name to array of nodes
    var hostToNodes = {};
    var hostToStartTime = {};

    // Set of existing hosts
    var hostSet = {};

    var mg = this;

    initHosts();
    initPrevNext();
    initParentChild();

    /*
     * Create and add nodes to host arrays. Initialize hosts if undefined by
     * adding them to hostSet and assigning head and tail dummy nodes
     */
    function initHosts() {
        for (var i = 0; i < logEvents.length; i++) {
            var logEvent = logEvents[i];
            var host = logEvent.getHost();
            var node = new ModelNode([ logEvent ]);
            node.host = host;
            node.graph = mg;

            if (hostSet[host] == undefined) {
                hostSet[host] = true;
                mg.hosts.push(host);
                hostToNodes[host] = [];

                var head = new ModelNode([]);
                head.isHeadInner = true;
                head.host = host;
                head.graph = mg;

                var tail = new ModelNode([]);
                tail.isTailInner = true;
                tail.host = host;
                tail.graph = mg;

                head.prev = null;
                head.next = tail;

                tail.prev = head;
                tail.next = null;

                mg.hostToHead[host] = head;
                mg.hostToTail[host] = tail;
            }

            hostToNodes[host].push(node);
        }
    }

    // Generate linear linked list among nodes in same host
    function initPrevNext() {

        let mostEvents = undefined;
        let maxLength = -Infinity;
        for (var host in hostToNodes) {
            var array = hostToNodes[host];
            array.sort(function(a, b) {
                return getVT(a).compareToLocal(getVT(b));
            });

            let currTime;
            if (array.length >= 1) {
                currTime = getTime(array[0])-1;
                hostToStartTime[host] = currTime;
            }
            for (var i = 0; i < array.length; i++) {
                var node = array[i];
                // we allow clocks to not start at 1 since we now view a sliding window
                if (getTime(node) != currTime + 1) {
                    throw getClockIncrementException(node, array[i - 1]);
                }
                currTime++;
            }

            var lastNode = mg.hostToHead[host];

            for (var i = 0; i < array.length; i++) {
                var newNode = array[i];
                lastNode.insertNext(newNode);
                lastNode = newNode;
            }

            if (array.length > maxLength) {
                maxLength = array.length;
                mostEvents = array;
            }
        }

        if (mostEvents === undefined) {
            return;
        }

        // designate which nodes will need to be observed with intersection observer
        // const startIdx = Math.floor(mostEvents.length/4);
        // const endIdx = Math.floor(mostEvents.length*3/4);

        // mg.shouldObserveNode(mostEvents[0], 'top');
        // mg.shouldObserveNode(mostEvents[startIdx], 'top');
        // mg.shouldObserveNode(mostEvents[mostEvents.length-2], 'bottom');
        // mg.shouldObserveNode(mostEvents[mostEvents.length-1], 'bottom');
    }

    // Generates parent and child connections
    function initParentChild() {
        // Generates parent/child connections
        for (var host in hostSet) {
            // Latest clock
            var clock = {};
            var currNode = mg.hostToHead[host].next;
            var tail = mg.hostToTail[host];

            while (currNode != tail) {
                // Candidates is array of potential parents for
                // currNode

                var candidates = [];
                var currVT = getVT(currNode);
                clock[host] = currVT.ownTime;

                // Looks to see if a timestamp for a host in the
                // vector clock has been updated from the last one
                for (var otherHost in currVT.clock) {
                    var time = currVT.clock[otherHost]; // TODO: use method

                    // If the timestamp for the host has been updated
                    // then add the node in otherHost with timestamp
                    // time to the list of candidates
                    if (clock[otherHost] == undefined || clock[otherHost] < time) {
                        clock[otherHost] = time;

                        // this can now happen if range we see don't happen to have
                        // log from this host. for now just ignore and continue
                        // could also add this host, but it would just be a blank host
                        if (hostSet[otherHost] == undefined) {
                            continue;
                            throw getBadHostException(currNode, otherHost);
                        }

                        if (time < 1 || time > hostToStartTime[otherHost] + hostToNodes[otherHost].length) {
                            // console.log("uhh", time, hostToNodes[otherHost].length, currNode)
                            throw getOutOfBoundsTimeException(currNode, otherHost, time);
                        }

                        if (hostToNodes[otherHost][time - hostToStartTime[otherHost] - 1] === undefined) {
                            // console.log("Candidate undefined", hostToStartTime, Object.keys(hostToNodes).map((host) => [host, [hostToNodes[host][0], hostToNodes[host][-1]]]), hostToStartTime[otherHost], time, time - hostToStartTime[otherHost], hostToNodes[otherHost].length)
                        } else {
                            candidates.push(hostToNodes[otherHost][time - hostToStartTime[otherHost]-1]);
                        }
                    }
                }

                // Gather all candidates into connections
                var connections = {};
                for (var i = 0; i < candidates.length; i++) {
                    // if (candidates[i] === undefined) {
                    //     console.log('what? ', candidates, candidates.length)
                    // }
                    var vt = getVT(candidates[i]);
                    var id = vt.getOwnHost() + ":" + vt.getOwnTime();
                    connections[id] = candidates[i];
                }

                for (var i = 0; i < candidates.length; i++) {
                    var vt = candidates[i].logEvents[0].getVectorTimestamp();
                    for (var otherHost in vt.clock) {
                        if (otherHost != vt.getOwnHost()) {
                            var id = otherHost + ":" + vt.clock[otherHost];
                            delete connections[id];
                        }
                    }
                }

                // figure out which child to keep
                for (var key in connections) {
                    var node = connections[key];
                    var currParentOnHost = currNode.hostToParent[node.getHost()];
                    if (!currParentOnHost) {
                        currNode.addParent(node);
                        continue;
                    }

                    if (getTime(node) > getTime(currParentOnHost)) {
                        currNode.addParent(node);
                    }

                }

                currNode = currNode.next;
            }
        }
    }

    function stepThroughAndVerify() {
        // Step through and verify that the vector clocks make sense
        var clocks = {}; // clocks[x][y] = vector clock of host x at local
        // time y
        for (var host in hostSet) {
            clocks[host] = {};
        }

        for (var host in hostSet) {
            var curr = mg.getHead(host).getNext();
            var time = 0;
            while (!curr.isTail()) {
                var clock = {};
                clock[host] = ++time;
                clocks[host][time] = new VectorTimestamp(clock, host);
                curr = curr.getNext();
            }
        }

        var sortedNodes = null;
        try {
            sortedNodes = mg.getNodesTopologicallySorted();
        }
        catch (e) {
            throw new Exception("An error occured. The log is intransitive. That is, there are three events x, y, and z such that x occurs before y, y occurs before z, and z before x.", true);
        }

        for (var i = 0; i < sortedNodes.length; i++) {
            var curr = sortedNodes[i];
            var host = curr.getHost();
            var time = curr.getFirstLogEvent().getVectorTimestamp().getOwnTime();

            var children = curr.getChildren();
            if (!curr.getNext().isTail()) {
                children.push(curr.getNext());
            }

            for (var j = 0; j < children.length; j++) {
                var childHost = children[j].getHost();
                var childTime = children[j].getFirstLogEvent().getVectorTimestamp().getOwnTime();
                clocks[childHost][childTime] = clocks[childHost][childTime].update(clocks[host][time]);
            }

            if (!clocks[host][time].equals(getVT(curr))) {
                var exception = new Exception("The following event has an impermissible vector clock.\n");
                attachEvent(curr.getFirstLogEvent(), exception);
                exception.append("We think it should be:");
                exception.append(JSON.stringify(clocks[host][time].clock), "code");
                exception.setUserFriendly(true);
                throw exception;
            }
        }
    }

    function attachEvent(event, exception) {
        var vt = event.getVectorTimestamp();
        exception.append("\nOn line " + event.getLineNumber() + ":");
        exception.append(event.getText() + "\n" + JSON.stringify(vt.clock), "code");
    }

    function getVT(node) {
        return node.getFirstLogEvent().getVectorTimestamp();
    }

    function getTime(node) {
        return getVT(node).getOwnTime();
    }

    function getStartValueException(node) {
        var exception = new Exception("Logical clock values for each host must start at 1.\n" + "The clock value for the first event for host \"" + node.getHost() + "\" is " + getTime(node) + ".");
        attachEvent(node.getFirstLogEvent(), exception);
        exception.setUserFriendly(true);
        return exception;
    }

    function getClockIncrementException(node, lastNode) {
        var exception = new Exception("Clock values for a host must increase monotonically by 1.\n" + "The clock for host \"" + node.getHost() + "\" goes from " + getTime(lastNode) + " to " + getTime(node) + " in the following two events:\n");
        attachEvent(lastNode.getFirstLogEvent(), exception);
        attachEvent(node.getFirstLogEvent(), exception);
        exception.setUserFriendly(true);
        return exception;
    }

    function getBadHostException(node, host) {
        var exception = new Exception("The following event's vector clock contains an entry for " + "an unrecognized host \"" + host + "\".");
        attachEvent(node.getFirstLogEvent(), exception);
        exception.setUserFriendly(true);
        return exception;
    }

    function getOutOfBoundsTimeException(node, host, time) {
        var exception = new Exception("The following event's vector clock contains an invalid clock value " + time + " for " + "host \"" + host + "\".");
        attachEvent(node.getFirstLogEvent(), exception);
        exception.setUserFriendly(true);
        return exception;
    }
}

// ModelGraph extends AbstractGraph
ModelGraph.prototype = Object.create(AbstractGraph.prototype);
ModelGraph.prototype.constructor = ModelGraph;

/**
 * Returns a copy of the graph. The new graph has nodes connected in exactly the
 * same way as the original. The new graph has exactly the same set of hosts.
 * The node themselves are shallow copies provided by node.clone()
 * 
 * @returns {ModelGraph} The copy of the graph
 */
ModelGraph.prototype.clone = function() {
    var newGraph = new ModelGraph([]);
    newGraph.hosts = this.getHosts();

    var allNodes = this.getAllNodes();
    var oldToNewNode = {};
    for (var i = 0; i < allNodes.length; i++) {
        var node = allNodes[i];
        var newNode = new ModelNode(node.getLogEvents());
        newNode.visualNode = node.visualNode;
        newNode.shouldObserve = node.shouldObserve;
        newNode.nodeType = node.nodeType;
        if (this.nodesToObserve.has(node)) {
            newGraph.nodesToObserve.add(newNode);
        }
        newNode.host = node.getHost();
        newNode.graph = newGraph;
        newNode.isHeadInner = node.isHeadInner;
        newNode.isTailInner = node.isTailInner;
        oldToNewNode[node.getId()] = newNode;
    }

    for (var host in this.hostToHead) {
        var node = this.hostToHead[host];
        newGraph.hostToHead[host] = oldToNewNode[node.getId()];
    }

    for (var host in this.hostToTail) {
        var node = this.hostToTail[host];
        newGraph.hostToTail[host] = oldToNewNode[node.getId()];
    }

    for (var i = 0; i < allNodes.length; i++) {
        var node = allNodes[i];
        var newNode = oldToNewNode[node.getId()];

        if (node.prev != null) {
            newNode.prev = oldToNewNode[node.prev.getId()];
        }

        if (node.next != null) {
            newNode.next = oldToNewNode[node.next.getId()];
        }

        var children = node.getChildren();
        for (var j = 0; j < children.length; j++) {
            var child = children[j];
            newNode.addChild(oldToNewNode[child.getId()]);
        }

    }

    return newGraph;
};

/**
 * Designate this node to observe with an intersection observer
 * @param {ModelNode} node
 */
ModelGraph.prototype.shouldObserveNode = function (node, nodeType) {
    if (node === undefined) {
        return
    }
    this.nodesToObserve.add(node);
    node.shouldObserve = true;
    node.nodeType = nodeType;
}

/**
 * Designate this node to observe with an intersection observer
 * @param {ModelNode} node
 * @param {String} nodeType top or bottom depending on node position in log events
 */
ModelGraph.prototype.shouldNotObserveNode = function (node) {
    this.nodesToObserve.delete(node)
    node.shouldObserve = false;
    node.nodeType = nodeType
}
