const webdav = require('webdav-server').v2;
const mfs = require('./MongoFS')
const mongoose = require('mongoose');

const url = process.env.DATABASE_URL ? process.env.DATABASE_URL : "mongodb://localhost:27017/files_db"
try {
  mongoose.connect(url, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    user: process.env.MONGO_INITDB_ROOT_USERNAME,
    pass: process.env.MONGO_INITDB_ROOT_PASSWORD,
  }).then((connection: any) => {
    console.log(`Connected to Mongo database "${connection.connections[0].name}"`)
  });
} catch (e) {
  console.error(e);
}

// User manager (tells who are the users)
const userManager = new webdav.SimpleUserManager();
const user = userManager.addUser('user', 'pass', true);

// Privilege manager (tells which users can access which files/folders)
const privilegeManager = new webdav.SimplePathPrivilegeManager();
privilegeManager.setRights(user, '/', ['all']);
const server = new webdav.WebDAVServer({
  // HTTP Digest authentication with the realm 'Default realm'
  httpAuthentication: new webdav.HTTPDigestAuthentication(userManager, 'Default realm'),
  privilegeManager: privilegeManager,
  rootFileSystem: new mfs.MongoFS(),
  port: 1900, // Load the server on the port 2000 (if not specified, default is 1900)
});

server.start(() => console.log('READY'));

