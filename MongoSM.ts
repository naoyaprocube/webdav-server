const wds = require('webdav-server').v2;
export class MongoSM extends wds.NoStorageManager {
  constructor() {
    super(...arguments);
  }
}