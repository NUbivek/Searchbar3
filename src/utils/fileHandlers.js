import axios from 'axios';

export const uploadFiles = async (files, onProgress) => {
  const formData = new FormData();
  
  files.forEach(file => {
    formData.append('files', file);
  });

  const response = await axios.post('/api/upload', formData, {
    onUploadProgress: (progressEvent) => {
      const percentCompleted = Math.round(
        (progressEvent.loaded * 100) / progressEvent.total
      );
      onProgress(percentCompleted);
    },
    headers: {
      'Content-Type': 'multipart/form-data'
    }
  });

  return response.data;
};

export const supportedFileTypes = [
  '.pdf', '.txt', '.doc', '.docx', 
  '.xls', '.xlsx', '.csv', '.json'
];

export const validateFile = (file) => {
  const extension = '.' + file.name.split('.').pop().toLowerCase();
  if (!supportedFileTypes.includes(extension)) {
    return {
      valid: false,
      error: `Unsupported file type. Supported types: ${supportedFileTypes.join(', ')}`
    };
  }
  
  // 50MB limit
  if (file.size > 50 * 1024 * 1024) {
    return {
      valid: false,
      error: 'File size must be less than 50MB'
    };
  }
  
  return {
    valid: true,
    error: null
  };
};
