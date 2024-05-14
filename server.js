// net server
const NET = require('net');
const UTIL = require('util');
const OS = require('os');
const SERVER = new NET.Server();

// socket management
const CLIENTS = {}; // client id : socket
const VALIDATED = {}; // compare "valid" game sockets vs non valid
const HOSTS = {}; // host id : host socket + details
const HOSTING = {}; // client id : host id
const WORLDS = {}; // client id : temp store of world data from host
const SESSIONS = {}; // session id : host code
const UUID_CHARS = [
	"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l",
	"m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x",
	"y", "z", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J",
	"K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V",
	"W", "X", "Y", "Z", "1", "2", "3", "4", "5", "6", "7", "8",
	"9", "0", "!", "?"
];
const UUIDS = {};
const CLIENT_UUID_MAP = {};

// get address for logs
var LOCAL_ADDR = '';
var interfaces = OS.networkInterfaces()
for (var interface in interfaces) {
  interfaces[interface].forEach(function(a) {
    if (a.family == 'IPv4' && LOCAL_ADDR == '') LOCAL_ADDR = a.address
  })
}

// port 8335 is hardcoded into the game client itself so you will always
// have to use this port for your server!!
const PORT = 8335;

// globals
var CHARS = "abcdefghijkmnopqrstuvwxyzABCDEFGHIJKLMNPQRSTUVWXYZ1234567890".split('');
var PRELIM = "=:XSTART:=";
var DELIM = "=:XEND:=";
var SPLIT = "=::=";

// counts
var CLIENT_COUNT = 0;
var HOST_COUNT = 0;
var PEAK_COUNT = 0;

// uptime tracker
var START = new Date();
var UPTIME = 0;
var UPTIMESTAMP = "";

// just used for the logs
var VERS = '1.0.0';

// electron window
// yea i hate electron too but its easy to distro
var { app, BrowserWindow } = require('electron')
// if electron run window then listen
if (app != undefined) {
  var win = null
  app.whenReady().then(function() {
    win = new BrowserWindow({
      width: 960,
      height: 500,
      webPreferences: {
        nodeIntegration: true,
        preload: require('path').join(__dirname, 'preload.js')
      }
    })
    win.loadFile('index.html')
    // start server
    setTimeout(function() {
      SERVER.listen(process.env.PORT || PORT, function() {
        send_log("purple", _timestamp(), "BEENET_ONLINE", "IP: " + LOCAL_ADDR, "PORT: " + PORT, VERS);
      });
    }, 2000)
  })
// otherwise just listen
} else {
  SERVER.listen(process.env.PORT || PORT, function() {
    send_log("purple", _timestamp(), "BEENET_ONLINE", "IP: " + LOCAL_ADDR, "PORT: " + PORT, VERS);
  });
}
function _timestamp() {
  return new Date().toUTCString();
}
var _colormap = {
  purple: '\x1b[35m',
  pink: '\x1b[34m',
  red: '\x1b[31m',
  white: '\x1b[33m',
  green: '\x1b[32m'
}
// used so we can send logs to the window if using electron
function send_log(color, timestamp, key, arg1, arg2, arg3) {
  if (win != null) {
    // for some reason if you try sending the arguments list itself electron
    // will cry, so we do this stupid workaround
    win.webContents.send('sendData', 
      {color, timestamp, key, arg1, arg2, arg3}
    )
  } else {
    console.log(_colormap[color], timestamp, key, arg1, arg2, arg3)
  }
}

// socket connection handler
SERVER.on('connection', function(socket) {

  // setup socket config
  //socket.setNoDelay(false);
  socket.setKeepAlive(true, 1000);
  socket.setEncoding("utf8");
  socket.setTimeout(200000); // time out after 60s without having anything sent

  // create new unique ID for every client socket regardless of if they end up hosting
  socket.$client_id = create_id();
  CLIENTS[socket.$client_id] = socket;
  CLIENT_COUNT++;
  // also add a 64char UUID tied to each socket to use for sync actions
  set_uuid(socket.$client_id);
  
  // all data sent from the game ends in =:XEND:= 
  // for longer bits of data we have to wait for the event to give us a data stream ending in the delim
  socket.$data_stream = "";

  socket.on('data', function(chunk) {

    var chonk = chunk.toString();

    // get requests not allowed
    if (chonk.indexOf("GET") == 0 && chonk.indexOf("HTTP/1.1") != -1) {
      return http_respond(socket, "400 Bad Request", "BAD_BEEQUEST", socket.$client_id);
    }

    // xbox http requests
    if (chonk.indexOf("POST") == 0 && chonk.indexOf("HTTP/1.1") != -1 && chonk.indexOf("_INVITE_") != -1) {
      var sessionId = chonk.split('_INVITE_$$_')[1];
      var matching = find_session(sessionId);
      send_log('green', _timestamp(), "XBOX_INVITE_REQUEST", sessionId, matching);
      return http_respond(socket, "200 OK", matching, socket.$client_id);
    }

    // generic http reqs
    if (chonk.indexOf("POST") == 0 && chonk.indexOf("HTTP/1.1") != -1) {
      send_log('white', _timestamp(), 'HTTP_POST', socket.$client_id, chonk)
    }

    // add data to stream
    socket.$data_stream += chonk;

    // when we have a deliminator
    if (socket.$data_stream.indexOf(DELIM) > 0) {

      // handle multiple streams in one chunk
      var splits = socket.$data_stream.split(DELIM);
       // loop through multiple data splits
      for (var s = 0; s < splits.length; s++) {
        var split = splits[s];
        if (split != "") {
          //var str = split.split(PRELIM)[1];
          //process_data(str, socket, socket.$client_id);
          var data = split.split(PRELIM);
          if (data.length > 1) process_data(data[1], socket, socket.$client_id);
        }
      }

      // check if last split had some more data in
      if (splits.length > 0 && splits[splits.length-1] != "") {
        socket.$data_stream = splits[splits.length-1];
      } else {
        socket.$data_stream = "";
      }
      
    }
  });
  
  // in node 10+ if there is no error handler explicitly set for sockets the server will crash
  socket.on('error', function(err) { 
    console.log("SOCKET_ERROR_HANDLER", socket.$client_id);
    try {
      send_log("red", _timestamp(), "SOCKET_ERRORED", socket.$client_id, VALIDATED[socket.$client_id] != undefined ? "[Game]" : "[Bot]", err.code + ": " + err.message);
      send_log("red", _timestamp(), UTIL.getSystemErrorName(err.errno) + " (" + err.errno + ")");
    } catch(ex) {
      console.error("Error handler", err, ex);
    }
  });

  // handle disconnect, either forced or timeout
  socket.on('end', function() {
    console.log("SOCKET_TIMEOUT_HANDLER", socket.$client_id);
  });

  socket.on('close', function(err) { 
    console.log("SOCKET_CLOSE_HANDLER", socket.$client_id);
    if (err) send_log("red", _timestamp(), "SOCKET_CLOSE_ERR", err);
    handle_disconnect(socket, socket.$client_id, "(Connection Closed)"); 
  });

  socket.on('timeout', function() { 
    console.log("SOCKET_END_HANDLER", socket.$client_id);
    handle_disconnect(socket, socket.$client_id, "(Connection Timed Out)"); 
  });
  
});

// handle server crash
SERVER.on("error", function(err) {
  send_log("red", _timestamp(), "Fatal Server Error", err);
});


/*
 *  @method - logger()
 *  @desc - keeps track of the amount of connections currently held by the server
 * 
 *  @return {Null}
 */
function logger() {
  SERVER.getConnections(function(err, count) {
    var uuid_keys = Object.keys(UUIDS);
    send_log(
      "pink", 
      _timestamp(),
      "SERVER_STATUS", 
      CLIENT_COUNT + " clients - " + 
      HOST_COUNT + " hosting", "[Uptime " + UPTIMESTAMP + "]", 
      "(" + count + " connections | " + PEAK_COUNT + " peak | " + uuid_keys.length + " uuids)");
    setTimeout(function() {
      logger();
    }, 10000);
  })
}
logger();


/*
 *  @method - create_uuid()
 *  @desc - creates a 64char random UUID unique to the UUIDS map in this server
 * 
 *  @return {String} - returns the UUID string
 */
function create_uuid() {
  var uuid = "";
  for (var a = 0; a < 64; a++) {
    var char = Math.floor(Math.random() * UUID_CHARS.length);
    uuid += UUID_CHARS[char];
  }
  if (UUIDS[uuid] != undefined) return uuid();
  UUIDS[uuid] = true;
  return uuid;
}


/*
 *  @method - set_uuid()
 *  @desc - returns the UUID mapped to a client key, creates a new UUID
 *          if it needs to
 * 
 *  @param {String} client_id - socket client id (unique 5 char key)
 * 
 *  @return {String} - returns the UUID mapped to this client id
 */
function set_uuid(client_id) {
  if (CLIENT_UUID_MAP[client_id] == undefined) {
    var uuid = create_uuid();
    CLIENT_UUID_MAP[client_id] = uuid;
    return uuid;
  } else {
    return CLIENT_UUID_MAP[client_id];
  }
}


/*
 *  @method - tracker()
 *  @desc - make a nice uptime stamp for logging
 * 
 *  @return {Null}
 */
function tracker() {
  setTimeout(function() {

    // get seconds uptime
    UPTIME = new Date() - START;
    var seconds = UPTIME/1000;

    // get hours total
    var hours = Math.floor(seconds / (60*60));
  
    // get days/hours/mins/seconds relatve
    var d = Math.floor(hours / 24);
    var h = hours % 24;
    var m = Math.floor(seconds % (60*60) / 60);
    var s = Math.floor(seconds % 60);
    
    // form uptime string
    var dd = d < 10 ? "00" + d : d < 100 ? "0" + d : d;
    var hh = h < 10 ? "0" + h : h;
    var mm = m < 10 ? "0" + m : m;
    var ss = s < 10 ? "0" + s : s;
    UPTIMESTAMP = dd + ":" + hh + ":" + mm + ":" + ss;

    tracker();
  }, 1000);
}
tracker();


/*
 *  @method - create_id()
 *  @desc - creates a unique ID for each client socket
 * 
 *  @return {String} - returns a new unique ID
 */
function create_id() {
  var id = "";
  for (var a = 0; a < 5; a++) {
    var random_number = Math.floor((Math.random() * CHARS.length));
    var random_char = CHARS[random_number];
    id += random_char;
  }
  if (CLIENTS[id] != undefined) return create_id();
  return id;
}


/*
 *  @method - handle_disconnect()
 *  @desc - handles a socket getting disconnected from the server for some reason
 * 
 *  @param {Object} socket - the net socket object for the socket that disconnected
 *  @param {String} client_id - the unique ID for this socket
 * 
 *  @return {Null}
 */
function handle_disconnect(socket, client_id, reason) {

  console.log("orange", _timestamp(), "SOCKET_DISCONNECTED", client_id, CLIENT_UUID_MAP[client_id], VALIDATED[client_id] != undefined ? "[Game]" : "[Bot]", reason);

  // remove client entry
  if (CLIENTS[client_id] != undefined) {
    delete CLIENTS[client_id];
    CLIENT_COUNT--;
  }
  // remove client UUID too so its freed up for other sockets
  if (CLIENT_UUID_MAP[client_id] != undefined) {
    var remove_uuid = CLIENT_UUID_MAP[client_id];
    delete CLIENT_UUID_MAP[client_id];
    if (UUIDS[remove_uuid] != undefined) delete UUIDS[remove_uuid];
  }
  if (VALIDATED[client_id] != undefined) delete VALIDATED[client_id];

  // remove hosting client entry
  if (HOSTING[client_id] != undefined) {
    var host = HOSTS[HOSTING[client_id]];
    if (host != undefined) {
      var lost = { code: "FRIEND_LOST", uuid: "" };
      if (host.p1.client_id == client_id) {
        host.p1.socket = -1;
        lost.uuid = host.p1.uuid + "";
        respond(host.socket, lost);
        if (host.p2.socket != -1) respond(host.p2.socket, lost);
        if (host.p3.socket != -1) respond(host.p3.socket, lost);
        host.p1.uuid = "";
        host.p1.client_id = "";
      }
      if (host.p2.client_id == client_id) {
        host.p2.socket = -1;
        lost.uuid = host.p2.uuid + "";
        respond(host.socket, lost);
        if (host.p1.socket != -1) respond(host.p1.socket, lost);
        if (host.p3.socket != -1) respond(host.p3.socket, lost);
        host.p2.uuid = "";
        host.p2.client_id = "";
      }
      if (host.p3.client_id == client_id) {
        host.p3.socket = -1;
        lost.uuid = host.p3.uuid + "";
        respond(host.socket, lost);
        if (host.p1.socket != -1) respond(host.p1.socket, lost);
        if (host.p2.socket != -1) respond(host.p2.socket, lost);
        host.p3.uuid = "";
        host.p3.client_id = "";
      }
    }
    //if (SESSIONS[host.rid] != undefined) delete SESSIONS[host.rid];
    delete HOSTING[client_id];
  }

  // handle host disconnect for clients
  if (HOSTS[client_id] != undefined) {
    var host = HOSTS[client_id];
    var msg = { code: "HOST_LOST" };
    // ping connected sockets
    if (host.p1.socket != -1) {
      if (WORLDS[host.p1.client_id] != undefined) delete WORLDS[host.p1.client_id];
      if (HOSTING[host.p1.client_id] != undefined) delete HOSTING[host.p1.client_id];
      respond(host.p1.socket, msg);
    }
    if (host.p2.socket != -1) {
      if (WORLDS[host.p2.client_id] != undefined) delete WORLDS[host.p2.client_id];
      if (HOSTING[host.p2.client_id] != undefined) delete HOSTING[host.p2.client_id];
      respond(host.p2.socket, msg);
    }
    if (host.p3.socket != -1) {
      if (WORLDS[host.p3.client_id] != undefined) delete WORLDS[host.p3.client_id];
      if (HOSTING[host.p3.client_id] != undefined) delete HOSTING[host.p3.client_id];
      respond(host.p3.socket, msg);
    }
    // clean host record
    delete HOSTS[client_id];
    HOST_COUNT--;
  }

  // kill me
  socket.destroy();
}


/*
 *  @method - respond()
 *  @desc - helper to write data to a socket
 * 
 *  @param {Object} socket - the net socket object to write data too
 *  @param {Object} data - obj data to be turned into JSON and written
 * 
 *  @return {Null}
 */
function respond(socket, data) {
  // all data returned has to also follow the PRELIM > DATA > DELIM format
  // this is so the sockets in the game can handle data the same way the server does
  try {
    var sent = socket.write(PRELIM + JSON.stringify(data) + DELIM);
    if (sent == false) {
      send_log("red", _timestamp(), "SOCKET_FLUSH_FAIL",  data);
    }
  } catch(ex) {
    send_log("red", _timestamp(), "SOCKET_WRITE_FAIL", data, ex);
  }
}


/*
 *  @method - process_data()
 *  @desc - helper to handle data string, split into sections and pass on to the handler
 * 
 *  @param {String} str - the string data got from the socket data stream
 *  @param {Object} socket - the socket that we are working with
 *  @param {String} client_id - the client_id for the socket we are working with
 * 
 *  @return {Null}
 */
function process_data(str, socket, client_id) {
  // handle socket data
  if (str != undefined && str.indexOf(SPLIT) != -1) {
    var data = str.split(SPLIT);
    handle_data(socket, client_id, data[0], data);
  }
}


/*
 *  @method - respond()
 *  @desc - helper to write data to a socket that was a HTTP request
 * 
 *  @param {Object} socket - the http socket object to write data too
 *  @param {String} code - http status code, either "200 OK" or "404 Not Found"
 *  @param {String} data - data to be written in the response
 * 
 *  @return {Null}
 */
function http_respond(socket, code, data, client_id) {
  send_log("blue", _timestamp(), "HTTP_RESPONSE", client_id, CLIENT_UUID_MAP[client_id], VALIDATED[client_id] != undefined ? "[Game]" : "[Bot]", "(" + code + ")");
  socket.write([
    'HTTP/1.1 ' + code,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Encoding: UTF-8',
    'Accept-Ranges: bytes',
    'Connection: Closed',
  ].join('\n') + '\n\n');
  socket.write(data);
  socket.end();
}
function find_session(sessionId) {
  for (var h in HOSTS) {
    if (HOSTS[h].sessions.indexOf(sessionId) != -1) {
      return HOSTS[h].client_id;
    }
  }
  return "";
}


/*
 *  @method - handle_data()
 *  @desc - handles data received from a given socket
 * 
 *  @param {Object} socket - the net socket object for the socket that disconnected
 *  @param {String} client_id - the unique ID for this socket
 *  @param {String} code - the data code for this transaction, can be one of the following:
 *    "HOST_REQUEST" => When a player clicks "Host" to get their code and start hosting
 *  @param {Object} data - any json data passed from the client that we might need
 * 
 *  @return {Null}
 */
function handle_data(socket, client_id, code, data) {

  try {

    // ignore HTTP calls, first socket sync logs this as "valid" so we can compare vs bot action
    if (VALIDATED[client_id] == undefined && (code != "HOST_WORLD" && code != "WORLD_DATA")) {
      VALIDATED[client_id] = true;
      if (CLIENT_COUNT > PEAK_COUNT) PEAK_COUNT = CLIENT_COUNT + 0;
      send_log("yellow", _timestamp(), "SOCKET_CONNECTED", client_id, CLIENT_UUID_MAP[client_id], "[Game]", "(Sync Started)");
    }
  
    // keep alive ping
    if (code == "PING") {
      respond(CLIENTS[client_id], { code: code, uuid: CLIENT_UUID_MAP[client_id] });
    }
  
    // host request when a player clicks "host"
    if (code == "HOST_REQUEST" && HOSTS[client_id] == undefined) {
      // create host entry & return host key
      // originally was gunna let the game specify a max friend option
      // but never implemented, is always 4
      var max_friends = data[1];
      var cross_play = data[2];
      HOSTS[client_id] = { 
        socket: socket, 
        client_id: client_id, uuid: "", name: "", pal: "", 
        status: "New", oss: data[3], cp: cross_play == 'Y' ? true : false,
        sid: "", rid: "", cid: "", tag: "", banned: [], sessions: [],
        p1: { socket: -1, client_id: "", uuid: "", name: "", pal: "", oss: "", cp: true, tag: "", cid: "" },
        p2: { socket: -1, client_id: "", uuid: "", name: "", pal: "", oss: "", cp: true, tag: "", cid: "" },
        p3: { socket: -1, client_id: "", uuid: "", name: "", pal: "", oss: "", cp: true, tag: "", cid: "" }
      }
      send_log('white', _timestamp(), "NEW_HOST", client_id, CLIENT_UUID_MAP[client_id], data[1], data[2], data[3]);
      HOST_COUNT++;
      respond(CLIENTS[client_id], { code: code, key: client_id });
    }

    // player sends their oss value
    if (code == "CROSS_PLAY") {
      // host client
      if (HOSTS[client_id] != undefined) {
        HOSTS[client_id].cp = data[1] == 'Y' ? true : false;
        HOSTS[client_id].oss = data[2];
      // normal client
      } else {
        CLIENTS[client_id].cp = data[1] == 'Y' ? true : false;
        CLIENTS[client_id].oss = data[2];
      }
    }
  
    // host request when a player has hosted, got their code, and loaded a world
    if (code == "HOST_READY" && HOSTS[client_id] != undefined) {
      HOSTS[client_id].status = "Ready"; // used in the UI to show a friend joining that the host is/isn't ready
      HOSTS[client_id].uuid = data[1];
      HOSTS[client_id].name = data[2];
      HOSTS[client_id].pal = data[3];
      HOSTS[client_id].oss = data[4];
      HOSTS[client_id].tag = data[5];
      HOSTS[client_id].cid = data[6];
      send_log('white', _timestamp(), "HOST_READY", client_id, CLIENT_UUID_MAP[client_id], data);
      respond(HOSTS[client_id].socket, { code: "HOST_DONE", uuid: CLIENT_UUID_MAP[client_id] });
    }
  
    // friend requests to join with a host key
    if (code == "FRIEND_JOIN" && data[1] != undefined) {
      var client = CLIENTS[client_id];
      // 2 is crossplay, 3 is oss, 4 is uuid, 5 is gamerid
      client.cp = data[2] == 'Y' ? true : false;
      client.oss = data[3];
      client.cid = data[5];
      var host = HOSTS[data[1]];
      var allow_join = true;
      var is_blocked = false;

      // if host has reported friend previously from this game
      if (host != undefined) {
        try {
          if (host.banned.indexOf(data[4]) != -1) is_blocked = true;
        } catch(ex) {}
      }
      
      // if host has disabled crossplay
      if (host != undefined) {
        send_log('white', _timestamp(), "FRIEND_JOIN", host.cp, client.cp, host.oss, client.oss, data[2], is_blocked, CLIENT_UUID_MAP[client_id]);
        // if the host or client has blocked crossplay
        if (host.cp == false || client.cp == false) {
          // if one of the players has an UNKNOWN oss then no idea what they're joining from
          // but it's not a known platform so might as well allow it
          if (host.oss != 'UNKNOWN' && client.oss != 'UNKNOWN') {
            // if the host and client os don't match don't let them join
            if (host.oss != client.oss) allow_join = false;
          }
        }
      }

      // blocked player
      if (is_blocked == true) {
        respond(client, { code: code, err: "You have been reported by the host and blocked from rejoining this game." });
      } else

      // invalid host key
      if (host == undefined || allow_join == false) {
        respond(client, { code: code, err: "HOST_INVALID" });
      // valid friend yay
      } else {
        // check host status
        if (host.status != "Ready") {
          respond(client, { code: code, err: "HOST_WAITING" });
        // pick friend slot
        } else if (host.p1.socket == -1 || host.p2.socket == -1 || host.p3.socket == -1) {
          // the game is hardcoded to handle a max of 8 different players (a,b,c,d,e,f,g,h)
          // so you could modify the server code to make it a max of 8 players but 
          // i think the lag of that would kill it way earlier
          var p = host.p1.socket == -1 ? "p1" : host.p2.socket == -1 ? "p2" : "p3";
          host[p].socket = socket;
          host[p].client_id = client_id;
          HOSTING[client_id] = host.client_id;
          respond(client, { code: code, err: 0, host_uuid: host.uuid, client_uuid: CLIENT_UUID_MAP[client_id] });
          respond(host.socket, { code: "HOST_WORLD", host_id: host.client_id, host_uuid: host.uuid, client_id: client_id });
        // no room in the inn
        } else {
          respond(client, { code: code, err: "HOST_FULL" });
        }
      }
    }
  
    // host responding with initial world data, stored temp
    if (code == "HOST_WORLD") {
      var host = HOSTS[data[1]];
      var c_id = data[2];
      var client = CLIENTS[c_id];
      send_log('white', _timestamp(), 'HOST_WORLD_UPLOADED', host.client_id);
      // store world data under the requesting client id 
      // otherwise 2 clients requesting a host world synchronously would go boom
      if (host != undefined && client != undefined) {
        if (WORLDS[c_id] == undefined) WORLDS[c_id] = data[3]; // update if empty
        // ping clients to say its ready
        respond(client, { code: "WORLD_READY", host_id: host.client_id, client_id: data[2] });
        // end socket request
        http_respond(socket, "200 OK", "SUCCESS", client_id);
      } else {
        http_respond(socket, "404 Not Found", "INVALID_HOST", client_id);
      }
    }
  
    // client asking for actual world data
    if (code == "WORLD_DATA") {
      var host = HOSTS[data[1]];
      var host = { client_id: data[1] };
      send_log('white', _timestamp(), 'CLIENT_WORLD_REQUEST', data[1]);
      if (host != undefined && WORLDS[data[2]] != undefined) {
        http_respond(socket, "200 OK", WORLDS[data[2]], client_id);
        WORLDS[data[2]] = undefined; // clear world 'cache'
      } else {
        http_respond(socket, "404 Not Found", "INVALID_HOST", client_id);
      }
    }
  
    // friend responding when they have recieved the world and the world has loaded
    if (code == "FRIEND_READY" && HOSTING[client_id] != undefined) {
      // set uuids
      var host = HOSTS[HOSTING[client_id]];
      var p = host.p1.client_id == client_id ? "p1" : host.p2.client_id == client_id ? "p2" : "p3";
      host[p].uuid = data[1];
      host[p].name = data[2];
      host[p].pal = data[3];
      host[p].oss = data[4];
      host[p].tag = data[5];
      host[p].cid = data[6];
      // update all players
      var data = { 
        code: "FRIEND_READY",  
        a: { uuid: host.uuid, name: host.name, pal: host.pal, oss: host.oss, tag: host.tag, cid: host.cid },
        b: { uuid: host.p1.uuid, name: host.p1.name, pal: host.p1.pal, oss: host.p1.oss, tag: host.p1.tag, cid: host.p1.cid },
        c: { uuid: host.p2.uuid, name: host.p2.name, pal: host.p2.pal, oss: host.p2.oss, tag: host.p2.tag, cid: host.p2.cid },
        d: { uuid: host.p3.uuid, name: host.p3.name, pal: host.p3.pal, oss: host.p3.oss, tag: host.p3.tag, cid: host.p3.cid }
      };
      respond(host.socket, data);
      if (host.p1.socket != -1) respond(host.p1.socket, data);
      if (host.p2.socket != -1) respond(host.p2.socket, data);
      if (host.p3.socket != -1) respond(host.p3.socket, data);
    }
  
    // player movement from any person
    if (code == "AVATAR_MOVE") {
      // shared res, b == boat (1 or 0), m == speed mead (1 or 0)
      var res = { code: "AVATAR_MOVE", uuid: data[1], x: data[2], y: data[3], b: data[4], m: data[5] };
      // host movement broadcast to all players
      if (HOSTS[client_id] != undefined) {
        var host = HOSTS[client_id];
        res.oss = host.oss;
        if (host.p1.socket != -1) respond(host.p1.socket, res);
        if (host.p2.socket != -1) respond(host.p2.socket, res);
        if (host.p3.socket != -1) respond(host.p3.socket, res);
      // client movement broadcast to host + other players
      } else if (HOSTING[client_id] != undefined) {
        var client = CLIENTS[client_id];
        res.oss = client.oss;
        var host = HOSTS[HOSTING[client_id]];
        respond(host.socket, res);
        if (host.p1.socket != -1 && host.p1.client_id != client_id) respond(host.p1.socket, res);
        if (host.p2.socket != -1 && host.p2.client_id != client_id) respond(host.p2.socket, res);
        if (host.p3.socket != -1 && host.p3.client_id != client_id) respond(host.p3.socket, res);
      }
    }

    // XBOX host sending a session id
    if (code == "XBOX_SESSION_ID") {
      // shared res for the session id
      // host players send session ID to current players
      if (HOSTS[client_id] != undefined) {
        var host = HOSTS[client_id];
        host.sid = data[1]; // CORRELATION ID
        host.rid = data[2]; // SESSION NAME
        send_log('green', _timestamp(), "XBOX_SESSION_ID_HOST", client_id, host.client_id, host.sid, host.rid);
        // update session map for invites
        host.sessions.push(host.rid); // ["0", "1", "2"]
        var res = { code: "XBOX_SESSION_ID", sid: data[1] };
        if (host.p1.socket != -1) respond(host.p1.socket, res);
        if (host.p2.socket != -1) respond(host.p2.socket, res);
        if (host.p3.socket != -1) respond(host.p3.socket, res);

      // client players can request the session ID from the host
      } else if (HOSTING[client_id] != undefined) {
        var client = CLIENTS[client_id];
        var host = HOSTS[HOSTING[client_id]];
        send_log('green', _timestamp(), "XBOX_SESSION_ID_CLIENT", client_id, host.client_id, host.sid, host.rid);
        var res = { code: "XBOX_SESSION_ID", sid: host.sid };
        respond(client, res);
      }
    }

    // XBOX player accepting invite
    if (code == "XBOX_SESSION_INVITE") {
      var client = CLIENTS[client_id];
      if (client != undefined) {
        var host_key = find_session(data[1]);
        send_log('green', _timestamp(), "XBOX_SESSION_INVITE", data[1], host_key);
        var res = { code: "XBOX_SESSION_INVITE", host_key: host_key };
        respond(client, res);
      }
    }
  
    // general sync action, just pass along to the right people!
    if (code == "SYNC") {
      // shared res
      var res = { code: "SYNC", json: data[1] }
      // host sync goes to all players
      if (HOSTS[client_id] != undefined) {
        var host = HOSTS[client_id];
        if (host.p1.socket != -1) respond(host.p1.socket, res);
        if (host.p2.socket != -1) respond(host.p2.socket, res);
        if (host.p3.socket != -1) respond(host.p3.socket, res);
      // client sync goes to host + other clients
      } else if (HOSTING[client_id] != undefined) {
        var host = HOSTS[HOSTING[client_id]];
        respond(host.socket, res);
        if (host.p1.socket != -1 && host.p1.client_id != client_id) respond(host.p1.socket, res);
        if (host.p2.socket != -1 && host.p2.client_id != client_id) respond(host.p2.socket, res);
        if (host.p3.socket != -1 && host.p3.client_id != client_id) respond(host.p3.socket, res);
      }
    }


    // friend kick
    if (code == "FRIEND_KICK") {
      // friend to kick
      var uuid = data[1];
      if (HOSTS[client_id] != undefined) {
        var host = HOSTS[client_id];
        var msg = { code: "HOST_LOST" };
        var lost = { code: "FRIEND_LOST", uuid: uuid };
        // check who to kick, send friend lost to others
        if (host.p1.socket != -1 && host.p1.uuid == uuid) {
          respond(host.p1.socket, msg);
          if (host.p2.socket != -1) respond(host.p2.socket, lost);
          if (host.p3.socket != -1) respond(host.p3.socket, lost);
        }
        if (host.p2.socket != -1 && host.p2.uuid == uuid) {
          respond(host.p2.socket, msg);
          if (host.p1.socket != -1) respond(host.p1.socket, lost);
          if (host.p3.socket != -1) respond(host.p3.socket, lost);
        }
        if (host.p3.socket != -1 && host.p3.uuid == uuid) {
          respond(host.p3.socket, msg);
          if (host.p1.socket != -1) respond(host.p1.socket, lost);
          if (host.p2.socket != -1) respond(host.p2.socket, lost);
        }
        // tell ourselves we lost the person too
        respond(host.socket, lost);
      }
    }


    // friend report
    // report already sent to guilded, this handles blocklist
    if (code == "FRIEND_REPORT") {
      // friend to kick
      var uuid = data[1];
      if (HOSTS[client_id] != undefined) {
        var host = HOSTS[client_id];
        host.banned.push(uuid);
        var msg = { code: "HOST_LOST" };
        var lost = { code: "FRIEND_LOST", uuid: uuid };
        // check who to kick, send friend lost to others
        if (host.p1.socket != -1 && host.p1.uuid == uuid) {
          respond(host.p1.socket, msg);
          if (host.p2.socket != -1) respond(host.p2.socket, lost);
          if (host.p3.socket != -1) respond(host.p3.socket, lost);
        }
        if (host.p2.socket != -1 && host.p2.uuid == uuid) {
          respond(host.p2.socket, msg);
          if (host.p1.socket != -1) respond(host.p1.socket, lost);
          if (host.p3.socket != -1) respond(host.p3.socket, lost);
        }
        if (host.p3.socket != -1 && host.p3.uuid == uuid) {
          respond(host.p3.socket, msg);
          if (host.p1.socket != -1) respond(host.p1.socket, lost);
          if (host.p2.socket != -1) respond(host.p2.socket, lost);
        }
        // tell ourselves we lost the person too
        respond(host.socket, lost);
      }
    }

  } catch(ex) {
    send_log("\x1b[31m", _timestamp(), "DATA_HANDLE_FAILED", client_id, ex);
  }

}



