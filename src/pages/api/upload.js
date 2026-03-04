import fs from 'fs';
import path from 'path';
import formidable from 'formidable';
import { processFile, cleanupFiles } from '../../utils/fileProcessing';
import { logger } from '../../utils/logger';

export const config = {
  api: {
    bodyParser: false,
  },
};

const uploadDir = path.join(process.cwd(), 'temp-uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const ALLOWED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
  'application/csv',
  'text/x-csv',
];

const MAX_FILE_SIZE = 25 * 1024 * 1024;

function flattenFormidableFiles(fileMap) {
  return Object.values(fileMap || {})
    .flatMap((entry) => Array.isArray(entry) ? entry : [entry])
    .filter(Boolean);
}

function normalizeUploadError(error) {
  const message = String(error?.message || '');
  const lowerMessage = message.toLowerCase();

  const isValidationError = (
    error?.httpCode === 400 ||
    error?.code === 1009 ||
    lowerMessage.includes('maxfiles') ||
    lowerMessage.includes('max file size') ||
    lowerMessage.includes('maxfilesize') ||
    lowerMessage.includes('maxfields') ||
    lowerMessage.includes('allowemptyfiles')
  );

  if (isValidationError) {
    return {
      status: 400,
      body: {
        error: 'Upload validation failed',
        details: message || 'Upload did not pass validation rules'
      }
    };
  }

  return {
    status: 500,
    body: {
      error: 'Upload failed',
      details: message || 'Unknown upload error'
    }
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const form = formidable({
      uploadDir,
      keepExtensions: true,
      maxFiles: 5,
      maxFileSize: MAX_FILE_SIZE,
      allowEmptyFiles: false,
      filter: (part) => Boolean(part.mimetype && ALLOWED_TYPES.includes(part.mimetype))
    });

    const [, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, parsedFiles) => {
        if (err) {
          reject(err);
          return;
        }

        resolve([fields, parsedFiles]);
      });
    });

    const parsedFiles = flattenFormidableFiles(files);
    if (parsedFiles.length === 0) {
      return res.status(400).json({
        error: 'No supported files uploaded',
        details: 'Supported types: PDF, DOCX, CSV, TXT'
      });
    }

    const uploadedFiles = await Promise.all(
      parsedFiles.map(async (file) => {
        try {
          const result = await processFile(file);
          return {
            ...result,
            error: null
          };
        } catch (error) {
          logger.error('File processing error:', error);
          return {
            name: file.originalFilename || file.newFilename,
            type: file.mimetype,
            size: file.size,
            content: '',
            metadata: {},
            error: error.message
          };
        }
      })
    );

    setTimeout(() => {
      cleanupFiles(parsedFiles).catch((error) => {
        logger.error('File cleanup error:', error);
      });
    }, 3600000);

    logger.info('Files uploaded successfully', {
      count: uploadedFiles.length,
      types: uploadedFiles.map((file) => file.type)
    });

    return res.status(200).json({
      files: uploadedFiles,
      message: 'Files will be automatically deleted after 1 hour'
    });
  } catch (error) {
    logger.error('Upload error:', error);
    const normalized = normalizeUploadError(error);
    return res.status(normalized.status).json(normalized.body);
  }
}
