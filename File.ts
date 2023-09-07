const mongooseSc = require('mongoose');
const { Schema } = mongooseSc;

const nameValidator = {
  validator: function(v:string) {
    return !v.includes('/')
  },
  message: 'filename must not include a slash'
}

const fileSchema = new Schema({
  filename: { 
    type: String, 
    required: true,
    validate: nameValidator
  },
  contentType: { type: String },
  length: { type: Number },
  chunkSize: { type: Number },
  uploadDate: { type: Date },
  metadata: {
    accessHistory: {
      type: [{
        Type: { type: String },
        Date: { type: Date },
        Protocol: { type: String },
        SourceIP: { type: String },
        Info: {type: String},
      }]
    },
    status: { type: String },
    parent_id: { type: String },
    fullpath: [{ type: String, }],
    unique: { type: String, unique: true },
  },
});

const chunkSchema = new Schema({
  files_id: { type: mongooseSc.Types.ObjectId },
  n: { type: Number },
});

const DirSchema = new Schema({
  dirname: { 
    type: String, 
    required: true,
    validate: nameValidator
  },
  uploadDate: { type: Date },
  parent_id: { type: String },
  fullpath: { type: [String] },
  unique: { type: String, unique: true },
});

module.exports = {
  files: mongooseSc.model('fs.files', fileSchema),
  chunks: mongooseSc.model('fs.chunks', chunkSchema),
  dirs: mongooseSc.model('fs.dirs', DirSchema),
}