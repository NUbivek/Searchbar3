/**
 * POST /api/upload (multipart, field "files", up to 5 files, 25 MB each)
 * -> { files: [{ name, type, size, content, metadata, error }] }
 *
 * Files are parsed to text on the server (PDF, DOCX, CSV, TXT) and the
 * temporary copy is deleted as soon as parsing finishes. Temporary files go
 * to the OS temp directory: on Vercel only /tmp is writable.
 */
import os from 'os';
import path from 'path';
import formidable from 'formidable';
import { processFile, cleanupFiles } from '../../utils/fileProcessing';
import { logger } from '../../utils/logger';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Accepted extension -> the MIME types a browser may declare for it. Both the
// extension and the declared type must match, so a .txt sent as
// application/pdf (or a .exe sent as text/plain) is rejected.
// Browsers sometimes declare binary files as application/octet-stream; the
// parser then verifies the content (a damaged or mislabelled file is reported).
const ALLOWED_FILES = {
  '.pdf': ['application/pdf', 'application/octet-stream'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'],
  '.txt': ['text/plain'],
  '.csv': ['text/csv', 'application/csv', 'text/x-csv', 'application/vnd.ms-excel', 'text/plain'],
};

const MAX_FILE_SIZE = 25 * 1024 * 1024;

export function isAllowedUpload(part) {
  const ext = path.extname(String(part?.originalFilename || '')).toLowerCase();
  const allowedTypes = ALLOWED_FILES[ext];
  if (!allowedTypes) return false;
  const mimetype = String(part?.mimetype || '').toLowerCase().split(';')[0].trim();
  return allowedTypes.includes(mimetype);
}

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
    status: 200,
    body: {
      status: 'fail-soft',
      error: 'Upload failed',
      details: message || 'Unknown upload error',
      degradedSources: ['upload']
    }
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let parsedFiles = [];
  try {
    const form = formidable({
      uploadDir: os.tmpdir(),
      keepExtensions: true,
      maxFiles: 5,
      maxFileSize: MAX_FILE_SIZE,
      allowEmptyFiles: false,
      filter: isAllowedUpload
    });

    const [, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, parsed) => {
        if (err) {
          reject(err);
          return;
        }

        resolve([fields, parsed]);
      });
    });

    parsedFiles = flattenFormidableFiles(files);
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

    logger.info('Files uploaded successfully', {
      count: uploadedFiles.length,
      types: uploadedFiles.map((file) => file.type)
    });

    return res.status(200).json({
      files: uploadedFiles,
      message: 'Files were parsed on the server and the uploaded copies deleted'
    });
  } catch (error) {
    logger.error('Upload error:', error);
    const normalized = normalizeUploadError(error);
    return res.status(normalized.status).json(normalized.body);
  } finally {
    // The temporary copies are only needed while parsing. A deferred cleanup
    // never runs in a serverless function, so delete them now.
    if (parsedFiles.length) {
      await Promise.resolve(cleanupFiles(parsedFiles)).catch((error) => {
        logger.error('File cleanup error:', error);
      });
    }
  }
}
