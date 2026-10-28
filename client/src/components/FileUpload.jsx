import { useState } from 'react';
import { Upload, X, FileImage, FileText, File } from 'lucide-react';
import toast from 'react-hot-toast';

const FileUpload = ({ onUpload, accept = '*', maxSize = 5 * 1024 * 1024, multiple = false }) => {
  const [files, setFiles] = useState([]);
  const [dragActive, setDragActive] = useState(false);

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    processFiles(droppedFiles);
  };

  const handleFileInput = (e) => {
    const selectedFiles = Array.from(e.target.files);
    processFiles(selectedFiles);
  };

  const processFiles = async (fileList) => {
    const validFiles = [];

    for (const file of fileList) {
      if (file.size > maxSize) {
        toast.error(`Arquivo "${file.name}" excede o tamanho máximo de ${(maxSize / 1024 / 1024).toFixed(1)}MB`);
        continue;
      }

      const preview = await createPreview(file);
      validFiles.push({
        file,
        preview,
        id: `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: file.name,
        size: file.size,
        type: file.type,
      });
    }

    const newFiles = multiple ? [...files, ...validFiles] : validFiles;
    setFiles(newFiles);
    onUpload && onUpload(newFiles);
  };

  const createPreview = (file) => {
    return new Promise((resolve) => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(file);
      } else if (file.type.startsWith('video/')) {
        resolve(file.type);
      } else {
        resolve(null);
      }
    });
  };

  const removeFile = (fileId) => {
    const updatedFiles = files.filter(f => f.id !== fileId);
    setFiles(updatedFiles);
    onUpload && onUpload(updatedFiles);
  };

  const getFileIcon = (type) => {
    if (type.startsWith('image/')) return FileImage;
    if (type.startsWith('video/')) return FileImage;
    if (type.includes('pdf')) return FileText;
    return File;
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div className="file-upload">
      <div
        className={`file-upload-zone ${dragActive ? 'drag-active' : ''}`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <input
          type="file"
          id="file-input"
          accept={accept}
          multiple={multiple}
          onChange={handleFileInput}
          className="visually-hidden"
        />
        <label htmlFor="file-input" className="file-upload-label">
          <Upload size={48} className="file-upload-icon" />
          <div className="file-upload-text">
            <div className="file-upload-title">Arraste e solte arquivos aqui</div>
            <div className="file-upload-subtitle">ou clique para selecionar</div>
            <div className="file-upload-limit">
              Tamanho máximo: {(maxSize / 1024 / 1024).toFixed(1)}MB
            </div>
          </div>
        </label>
      </div>

      {files.length > 0 && (
        <div className="file-list">
          {files.map((file) => {
            const Icon = getFileIcon(file.type);
            return (
              <div key={file.id} className="file-item">
                {file.preview && file.type.startsWith('image/') ? (
                  <div className="file-preview">
                    <img src={file.preview} alt={file.name} />
                  </div>
                ) : (
                  <div className="file-icon">
                    <Icon size={24} />
                  </div>
                )}
                <div className="file-info">
                  <div className="file-name" title={file.name}>{file.name}</div>
                  <div className="file-size">{formatFileSize(file.size)}</div>
                </div>
                <button
                  onClick={() => removeFile(file.id)}
                  className="file-remove"
                  aria-label="Remover arquivo"
                >
                  <X size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default FileUpload;
