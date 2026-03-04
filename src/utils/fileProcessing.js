import pdf from 'pdf-parse';
import XLSX from 'xlsx';
import mammoth from 'mammoth';
import { parse } from 'csv-parse';
import { promisify } from 'util';
import { logger } from './logger';
import { promises as fs } from 'fs';

const parseCSV = promisify(parse);

// File size limits in bytes
const FILE_SIZE_LIMITS = {
  'txt': 10 * 1024 * 1024,  // 10MB
  'pdf': 50 * 1024 * 1024,  // 50MB
  'xlsx': 20 * 1024 * 1024, // 20MB
  'xls': 20 * 1024 * 1024,  // 20MB
  'csv': 20 * 1024 * 1024,  // 20MB
  'json': 10 * 1024 * 1024, // 10MB
  'docx': 20 * 1024 * 1024, // 20MB
  'pptx': 50 * 1024 * 1024  // 50MB
};

// Supported file types and their processors
const FILE_PROCESSORS = {
  'txt': processTextFile,
  'pdf': processPDFFile,
  'xlsx': processExcelFile,
  'xls': processExcelFile,
  'csv': processCSVFile,
  'json': processJSONFile,
  'docx': processDocxFile,
  'pptx': processPPTXFile
};

// Supported file types and their handlers
const FILE_HANDLERS = {
  '.txt': handleTextFile,
  '.json': handleJsonFile,
  '.csv': handleCsvFile,
  '.xlsx': handleExcelFile,
  '.xls': handleExcelFile,
  '.pdf': handlePdfFile,
  '.docx': handleDocxFile
};

// Maximum file size (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function getFileName(file) {
  return file.originalFilename || file.name || 'upload';
}

function getFileExtension(file) {
  const fileName = getFileName(file);
  const parts = fileName.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function isNodeUpload(file) {
  return Boolean(file && file.filepath);
}

async function readUploadText(file) {
  if (isNodeUpload(file)) {
    const buffer = await fs.readFile(file.filepath);
    return buffer.toString('utf-8');
  }

  return file.text();
}

async function readUploadBuffer(file) {
  if (isNodeUpload(file)) {
    return fs.readFile(file.filepath);
  }

  const arrayBuffer = await file.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Process uploaded file
export async function processFile(file) {
  try {
    const fileName = getFileName(file);
    const extension = getFileExtension(file);

    // Validate file type
    if (!FILE_PROCESSORS[extension] && !FILE_HANDLERS[`.${extension}`]) {
      return Promise.reject(new Error(`Unsupported file type: ${extension}`));
    }

    // Validate file size
    const sizeLimit = FILE_SIZE_LIMITS[extension] || MAX_FILE_SIZE;
    if (file.size > sizeLimit) {
      return Promise.reject(new Error(`File size exceeds limit of ${sizeLimit / (1024 * 1024)}MB for ${extension} files`));
    }

    const content = isNodeUpload(file)
      ? await FILE_HANDLERS[`.${extension}`](file)
      : await FILE_PROCESSORS[extension](file);

    const normalizedContent = typeof content === 'string' ? content : content?.content || '';
    const metadata = typeof content === 'string' ? {} : content?.metadata || {};

    return {
      source: fileName,
      name: fileName,
      type: file.mimetype || 'application/octet-stream',
      size: file.size,
      content: normalizedContent,
      timestamp: new Date().toISOString(),
      title: fileName,
      metadata
    };
  } catch (error) {
    logger.error('File processing error:', error);
    return Promise.reject(error);
  }
}

// Process uploaded files
export async function processUploadedFiles(files) {
  const results = await Promise.allSettled(
    files.map(file => processFile(file))
  );

  // Filter out failed results but log them
  const processedFiles = results
    .map((result, index) => {
      if (result.status === 'rejected') {
        logger.error(`Failed to process file ${files[index].name}:`, result.reason);
        return null;
      }
      return result.value;
    })
    .filter(Boolean);

  return processedFiles;
}

async function processTextFile(file) {
  return readUploadText(file);
}

async function processJSONFile(file) {
  const text = await readUploadText(file);
  try {
    const json = JSON.parse(text);
    return JSON.stringify(json, null, 2);
  } catch (error) {
    return Promise.reject(new Error('Invalid JSON file'));
  }
}

async function processCSVFile(file) {
  const text = await readUploadText(file);
  try {
    const records = await parseCSV(text, {
      columns: true,
      skip_empty_lines: true
    });
    return {
      content: records.map(record => Object.values(record).join(', ')).join('\n'),
      metadata: {
        rowCount: records.length,
        columns: Object.keys(records[0] || {})
      }
    };
  } catch (error) {
    return Promise.reject(new Error('Invalid CSV file'));
  }
}

async function processExcelFile(file) {
  const buffer = await readUploadBuffer(file);
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    
    const sheets = {};
    let totalContent = '';
    
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const content = XLSX.utils.sheet_to_csv(sheet);
      sheets[sheetName] = content;
      totalContent += `Sheet: ${sheetName}\n${content}\n\n`;
    });
    
    return {
      content: totalContent,
      metadata: {
        sheets: Object.keys(sheets),
        sheetCount: workbook.SheetNames.length
      }
    };
  } catch (error) {
    return Promise.reject(new Error('Invalid Excel file'));
  }
}

async function processPDFFile(file) {
  const buffer = await readUploadBuffer(file);
  try {
    const data = await pdf(buffer, {
      max: 0,  // No page limit
      pagerender: async (pageData) => {
        const renderOptions = {
          normalizeWhitespace: true,
          disableCombineTextItems: false
        };
        return await pageData.getTextContent(renderOptions);
      }
    });

    return {
      content: data.text,
      metadata: {
        pageCount: data.numpages,
        info: data.info
      }
    };
  } catch (error) {
    return Promise.reject(new Error('Invalid or corrupted PDF file'));
  }
}

async function processDocxFile(file) {
  const buffer = await readUploadBuffer(file);
  try {
    const result = await mammoth.extractRawText({ buffer });
    return {
      content: result.value,
      metadata: {
        messages: result.messages
      }
    };
  } catch (error) {
    return Promise.reject(new Error('Invalid DOCX file'));
  }
}

async function processPPTXFile(file) {
  return Promise.reject(new Error('PPTX processing not implemented'));
}

// Handle text files
async function handleTextFile(file) {
  const buffer = await fs.readFile(file.filepath);
  return buffer.toString('utf-8');
}

// Handle JSON files
async function handleJsonFile(file) {
  const content = await handleTextFile(file);
  try {
    const data = JSON.parse(content);
    return JSON.stringify(data, null, 2);
  } catch (error) {
    return Promise.reject(new Error('Invalid JSON file'));
  }
}

// Handle CSV files
async function handleCsvFile(file) {
  const text = await handleTextFile(file);

  try {
    const records = await parseCSV(text, {
      columns: true,
      skip_empty_lines: true
    });

    return {
      content: records.map(record => Object.values(record).join(', ')).join('\n'),
      metadata: {
        rowCount: records.length,
        columns: Object.keys(records[0] || {})
      }
    };
  } catch (error) {
    return Promise.reject(new Error('Invalid CSV file'));
  }
}

// Handle Excel files
async function handleExcelFile(file) {
  const workbook = XLSX.readFile(file.filepath);
  const result = {};

  // Process each sheet
  workbook.SheetNames.forEach(sheetName => {
    const worksheet = workbook.Sheets[sheetName];
    result[sheetName] = XLSX.utils.sheet_to_json(worksheet);
  });

  return JSON.stringify(result, null, 2);
}

// Handle PDF files
async function handlePdfFile(file) {
  const buffer = await fs.readFile(file.filepath);

  try {
    const data = await pdf(buffer);
    return {
      content: data.text,
      metadata: {
        pageCount: data.numpages,
        info: data.info
      }
    };
  } catch (error) {
    return Promise.reject(new Error('Invalid or corrupted PDF file'));
  }
}

async function handleDocxFile(file) {
  const buffer = await fs.readFile(file.filepath);

  try {
    const result = await mammoth.extractRawText({ buffer });
    return {
      content: result.value,
      metadata: {
        messages: result.messages
      }
    };
  } catch (error) {
    return Promise.reject(new Error('Invalid DOCX file'));
  }
}

// Clean up temporary files
export async function cleanupFiles(files) {
  for (const file of files) {
    try {
      await fs.unlink(file.filepath);
    } catch (error) {
      logger.error('File cleanup error:', error);
    }
  }
}
