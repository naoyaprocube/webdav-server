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

class checkSizeStream extends Transform {
  constructor(limit: number, totalLimit: number, scanlimit: number) {
    super();
    this.sizeCheck = true
    this.uploadSizeLimit = limit
    this.totalUploadSizeLimit = totalLimit
    this.scanSizeLimit = scanlimit
    this.totalLength = FileModel.files.find({})
      .then((files: any) => files.map(file => file.length))
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
    this.reload = () => {
      this.resources = {
        '/': new wd.VirtualFileSystemResource(wd.ResourceType.Directory),
      };
      FileModel.files.find({}).then((files: any) => files.map((file: any) => {
        this.resources[file.metadata.unique.slice(5)] = new wd.VirtualFileSystemResource({
          size: file.length,
          lastModifiedDate: file.uploadDate.getTime(),
          creationDate: file.metadata.accessHistory[0].Date.getTime(),
          type: wd.ResourceType.File,
        })
      }))
      FileModel.dirs.find({}).then((dirs: any) => dirs.map((dir: any) => {
        this.resources[dir.unique.slice(5)] = new wd.VirtualFileSystemResource({
          size: 0,
          lastModifiedDate: dir.uploadDate.getTime(),
          creationDate: dir.uploadDate.getTime(),
          type: wd.ResourceType.Directory,
        })
      }))
      console.log("reload")
    }
    this.reload()
  }

  protected _create(path: any, ctx: any, callback: any): void {
    console.log(ctx.type)
    const cPath = "/root" + path.toString();
    console.log(cPath)
    const fullpath = cPath.split("/")
    fullpath.shift()
    const dirname = fullpath.pop()
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
          return callback()
        })
    }
    else {
      return FileModel.dirs.findOne({ fullpath: fullpath }).then((dir: any) => {
        if (dir) return callback(wd.Errors.ResourceAlreadyExists)
        else {
          this.resources[path.toString()] = new wd.VirtualFileSystemResource(ctx.type);
          return callback()
        }
      })

    }
  }

  protected _openWriteStream(path: any, ctx: any, callback: any): void {
    const resource = this.resources[path.toString()];
    if (resource === undefined)
      return callback(wd.Errors.ResourceNotFound);
    const bucket = gridfs.createBucket();
    const wPath = "/root" + path.toString();
    const status = isScan ? "WAITFOR_AVSCAN" : "COMPLETE"
    const fullpath = wPath.split("/")
    fullpath.shift()
    const fileName = fullpath.pop()
    const parent_fullpath = fullpath.slice(0, fullpath.length - 1)
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
          Protocol: "ftp",
          SourceIP: this.connection.commandSocket.remoteAddress,
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
          stream.end()
          if (updated_file) {
            const Attachment = gridfs.createModel();
            Attachment.unlink(updated_file._id, (error: any) => { });
          }
          this.reload()
        });
        callback(null, stream);
      }))


  }

  protected _delete(path: any, ctx: any, callback: any): void {
    const sPath = path.toString(true);
    console.log(sPath)
    for (const path in this.resources) {
      if (startsWith(path, sPath)) {
        if (this.resources[path].type.isFile) {
          console.log("filepath:" + path)
        }
        else if (this.resources[path].type.isDirectory) {
          console.log("dirpath" + path)
        }
      }
    }
    this.reload()
    callback();
  }
} 
