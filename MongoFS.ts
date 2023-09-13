const wd = require('webdav-server').v2;
const startsWith = require('./helper/utils').startsWith
const FileModel = require('./File')
const gridfs = require('mongoose-gridfs');
const uploadLimit = process.env.UPLOAD_SIZE_LIMIT ? Number(process.env.UPLOAD_SIZE_LIMIT) : 1024 * 1024 * 1024 * 10
const scanLimit = process.env.SCAN_SIZE_LIMIT ? Number(process.env.SCAN_SIZE_LIMIT) : 4294967296
const totalSizeLimit = process.env.UPLOAD_TOTAL_SIZE_LIMIT ? Number(process.env.UPLOAD_TOTAL_SIZE_LIMIT) : 1024 * 1024 * 1024 * 50
const isScan = process.env.FILESERVER_AV ? process.env.FILESERVER_AV : false
const EventEmitter = require('events');
const { Transform } = require('stream')
const checkEmitter = new EventEmitter();
const ipaddr = require('ipaddr.js');

const getIP = function (ctx: any) {
  if (ctx.context.request.socket.remoteAddress) {
    let address = ctx.context.request.socket.remoteAddress
    const addr = ipaddr.parse(address);
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
      address = addr.toIPv4Address().toString();
    }
    return address
  }
  return '0.0.0.0';
};

class checkSizeStream extends Transform {
  constructor(limit: number, totalLimit: number, scanlimit: number) {
    super();
    this.sizeCheck = true
    this.uploadSizeLimit = limit
    this.totalUploadSizeLimit = totalLimit
    this.scanSizeLimit = scanlimit
    this.totalLength = FileModel.files.find({})
      .then((files: any) => files.map((file: any) => file.length))
      .then((lengthList: Array<number>) => lengthList.reduce(function (sum: number, element: number) {
        return sum + element;
      }, 0))
    this.totalBytes = 0
  }

  _transform(chunk: Buffer, encoding: string, callback: any) {
    if (this.sizeCheck === false) {
      callback()
    } else {
      if (this.uploadSizeLimit != null && this.totalBytes + chunk.length > this.uploadSizeLimit) {
        checkEmitter.emit('size_over')
        this.sizeCheck = false
      }
      this.totalLength.then((length: number) => {
        if (length + this.totalBytes > this.totalUploadSizeLimit) {
          checkEmitter.emit('total_size_over')
          this.sizeCheck = false
        }
      })
      this.totalBytes += chunk.length
      callback(null, chunk)
    }
  }
}

export class MongoFS extends wd.VirtualFileSystem {
  constructor() {
    super(...arguments);
    this.resources = {
      '/': new wd.VirtualFileSystemResource(wd.ResourceType.Directory),
    };
    this.reload = () => new Promise((resolve, reject) => {
      this.resources = {
        '/': new wd.VirtualFileSystemResource(wd.ResourceType.Directory),
      };
      return FileModel.files.find({})
        .then((files: any) => files.map((file: any) => {
          this.resources[file.metadata.unique.slice(5)] = new wd.VirtualFileSystemResource({
            size: file.length,
            lastModifiedDate: file.uploadDate.getTime(),
            creationDate: file.metadata.accessHistory[0].Date.getTime(),
            type: wd.ResourceType.File,
          })
        }))
        .then(() => FileModel.dirs.find({}).then((dirs: any) => dirs.map((dir: any) => {
          this.resources[dir.unique.slice(5)] = new wd.VirtualFileSystemResource({
            size: 0,
            lastModifiedDate: dir.uploadDate.getTime(),
            creationDate: dir.uploadDate.getTime(),
            type: wd.ResourceType.Directory,
          })
        })))
        .then(() => {
          console.log("reload")
          return resolve("reload")
        })
    })
    this.reload()
  }

  protected _create(path: any, ctx: any, callback: any): void {
    const cPath = "/root" + path.toString();
    const fullpath = cPath.split("/")
    fullpath.shift()
    const dirname = fullpath[fullpath.length - 1]
    const parent_fullpath = fullpath.slice(0, fullpath.length - 1)
    if (ctx.type.isDirectory) {
      FileModel.dirs.findOne({ fullpath: parent_fullpath })
        .then((parent_dir: any) => FileModel.dirs.create({
          dirname: dirname,
          uploadDate: new Date,
          parent_id: (parent_dir) ? parent_dir._id.toString() : "root",
          fullpath: fullpath,
          unique: cPath
        }))
        .then(() => {
          this.reload()
          console.log("create dir")
          callback()
        })
    }
    else {
      FileModel.dirs.findOne({ fullpath: fullpath }).then((dir: any) => {
        if (dir) {
          return callback(wd.Errors.ResourceAlreadyExists)
        }
        else {
          this.resources[path.toString()] = new wd.VirtualFileSystemResource(ctx.type);
          console.log("create file")
          return callback()
        }
      })

    }
  }

  protected _openWriteStream(path: any, ctx: any, callback: any): void {
    console.log("open writestream")
    const resource = this.resources[path.toString()];
    const bucket = gridfs.createBucket();
    const wPath = "/root" + path.toString();
    const status = isScan ? "WAITFOR_AVSCAN" : "COMPLETE"
    const fullpath = wPath.split("/")
    fullpath.shift()
    const fileName = fullpath[fullpath.length - 1]
    const parent_fullpath = fullpath.slice(0, fullpath.length - 1)
    console.log(parent_fullpath)
    this.reload().then(() => {
      if (resource === undefined)
        return callback(wd.Errors.ResourceNotFound);
      FileModel.dirs.findOne({ fullpath: parent_fullpath })
        .then((parent_dir: any) => FileModel.files.findOneAndUpdate(
          { "metadata.unique": wPath },
          {
            "metadata.unique": "whileDeleting-ftp-" + fileName,
            "metadata.status": "UPDATING"
          }
        ).then((updated_file: any) => {
          if (!parent_dir && fullpath.length > 2) {
            delete this.resources[path.toString()];
            return callback(wd.Errors.ResourceNotFound)
          }
          const parent_id = parent_dir ? parent_dir._id.toString() : "root"
          const acHistory = updated_file ? updated_file.metadata.accessHistory : []
          acHistory.push({
            Type: updated_file ? "update" : "upload",
            Date: new Date,
            Protocol: "http",
            SourceIP: getIP(ctx),
            Info: "",
          })
          const options = ({
            filename: fileName,
            metadata: {
              accessHistory: acHistory,
              status: status,
              parent_id: parent_id,
              fullpath: fullpath,
              unique: wPath
            }
          });
          const stream = new checkSizeStream(uploadLimit, totalSizeLimit, scanLimit)
          const ws = bucket.createWriteStream(options)
          checkEmitter.once('size_over', () => {
            ws.abort()
            ws.emit('error', new Error('File size over'))
            stream.emit('error', new Error('File size over'))
          })
          checkEmitter.once('total_size_over', () => {
            ws.abort()
            ws.emit('error', new Error('Total file size over'))
            stream.emit('error', new Error('Total file size over'))
          })
          stream.pipe(ws)
          ws.once('error', (error: Error) => {
            if (updated_file) {
              FileModel.files.findOneAndUpdate(
                { _id: updated_file._id },
                {
                  "metadata.unique": wPath,
                  "metadata.status": status
                }
              ).then((file: any) => { })
            }
          })
          ws.once('finish', () => {
            if (updated_file) {
              const Attachment = gridfs.createModel();
              Attachment.unlink(updated_file._id, (error: any) => { });
            }
            this.reload()
          });
          console.log("callback stream")
          callback(null, stream);
        }))
    })
  }

  protected _openReadStream(path: any, ctx: any, callback: any): void {
    const resource = this.resources[path.toString()];
    const rPath = "/root" + path.toString()
    this.reload().then(() => {
      if (resource === undefined)
        return callback(wd.Errors.ResourceNotFound);
      else if (resource.type.isDirectory)
        return callback(wd.Errors.IllegalArguments);
      else return FileModel.files.findOne({ "metadata.unique": rPath }).then((file: any) => {
        if (file.metadata.status !== "COMPLETE") {
          return callback(wd.Errors.IllegalArguments);
        }
        else {
          const rBucket = gridfs.createBucket();
          const rsoptions = ({ _id: file._id });
          const stream = rBucket.createReadStream(rsoptions);
          stream.once('end', () => {
            const pushContent = {
              Type: "download",
              Date: new Date,
              Protocol: "http",
              SourceIP: getIP(ctx),
              Info: ""
            }
            FileModel.files.findOneAndUpdate(
              { "metadata.unique": rPath },
              { $push: { "metadata.accessHistory": pushContent } }
            ).then((file: any) => { })
          });
          return callback(null, stream)
        }
      })
    })
  }

  protected _delete(path: any, ctx: any, callback: any): void {
    const sPath = path.toString(true)
    const Attachment = gridfs.createModel();
    function removePath(_this: any, _path: string) {
      if (_this.resources[_path].type.isFile) {
        FileModel.files.findOne({ "metadata.unique": "/root" + _path })
          .then((file: any) => {
            if (file)
              Attachment.unlink(file._id, (error: any) => { _this.reload() })
            else {
              delete _this.resources[_path];
              _this.reload()
            }
          })
      }
      else if (_this.resources[_path].type.isDirectory) {
        FileModel.dirs.findOneAndDelete({ "unique": "/root" + _path })
          .then(() => _this.reload())
      }
    }
    this.reload()
      .then(() => {
        for (const path in this.resources) {
          if (startsWith(path, sPath)) {
            removePath(this, path)
          }
        }
        removePath(this, path.toString())
      })
      .then(() => callback())
  }

  protected _move(pathFrom: any, pathTo: any, ctx: any, callback: any): void {
    const sPathFrom = pathFrom.toString(true)
    const sPathTo = pathTo.toString()
    const movePath = (_this: any, _pathFrom: string, _pathTo: string, _parent_id: string) => new Promise((resolve, reject) => {
      console.log("pathfrom:" + _pathFrom)
      if (_this.resources[_pathFrom].type.isFile) {
        return FileModel.files.findOne({ "metadata.unique": "/root" + _pathFrom })
          .then((file: any) => {
            if (file) {
              const parent_id = (_parent_id === "false") ? file.metadata.parent_id : _parent_id
              const fullpath = _pathTo.split("/")
              fullpath.shift()
              fullpath.unshift("root")
              return FileModel.files.findOneAndUpdate(
                { "metadata.unique": "/root" + _pathFrom },
                {
                  "metadata.parent_id": parent_id,
                  "metadata.unique": "/root" + _pathTo,
                  "metadata.fullpath": fullpath
                }
              ).then((file: any) => {
                _this.reload()
                resolve("reload")
              })
            }
            else {
              console.log("cannot find file")
              _this.reload()
              resolve("reload")
            }
          })
      }
      else if (_this.resources[_pathFrom].type.isDirectory) {
        return FileModel.dirs.findOne({ "unique": "/root" + _pathFrom })
          .then((dir: any) => {
            if (dir) {
              const parent_id = (_parent_id === "false") ? dir.parent_id : _parent_id
              const fullpath = _pathTo.split("/")
              fullpath.shift()
              fullpath.unshift("root")
              return FileModel.dirs.findOneAndUpdate(
                { "unique": "/root" + _pathFrom },
                {
                  "parent_id": parent_id,
                  "unique": "/root" + _pathTo,
                  "fullpath": fullpath
                }
              ).then((file: any) => {
                _this.reload()
                resolve("reload")
              })
            }
            else {
              console.log("cannot find directory")
              _this.reload()
              resolve("reload")
            }
          })
      }
    })
    this.reload()
      .then(() => {
        const parent_fullpath = sPathTo.split("/")
        parent_fullpath.shift()
        parent_fullpath.unshift("root")
        parent_fullpath.pop()
        FileModel.dirs.findOne({ fullpath: parent_fullpath }).then((dir: any) => {
          if (dir || parent_fullpath.length === 1) {
            const parent_id = (parent_fullpath.length === 1) ? "root" : dir._id.toString()
            movePath(this, pathFrom.toString(), sPathTo, parent_id)
            for (const path in this.resources) {
              if (startsWith(path, sPathFrom)) {
                const fullpath = path.split("/")
                fullpath.shift()
                const from_fullpath = sPathFrom.split("/")
                from_fullpath.shift()
                from_fullpath.pop()
                const to_fullpath = sPathTo.split("/")
                to_fullpath.shift()
                const ppath = to_fullpath.concat(fullpath.slice(from_fullpath.length, fullpath.length))
                movePath(this, path, "/" + ppath.join("/"), "false")
              }
            }
          }
        })
      })
      .then(() => callback(true))
  }
  
} 
