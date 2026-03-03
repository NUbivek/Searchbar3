/** @jest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SourceSelector from '../../src/components/SourceSelector';
import { uploadFiles } from '../../src/utils/fileHandlers';

jest.mock('../../src/utils/fileHandlers', () => ({
  uploadFiles: jest.fn(),
}));

describe('SourceSelector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('adds a valid custom URL and clears any validation error', async () => {
    const onCustomSourceAdd = jest.fn();

    render(
      <SourceSelector
        mode="open"
        selectedSources={['Web']}
        onSourceToggle={jest.fn()}
        onCustomSourceAdd={onCustomSourceAdd}
        onFileUpload={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /custom/i }));

    const input = screen.getByPlaceholderText('Add website URL');
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(onCustomSourceAdd).toHaveBeenCalledWith('https://example.com');
      expect(screen.queryByText('Please enter a valid URL')).toBeNull();
    });
  });

  it('shows a validation error for an invalid custom URL', () => {
    render(
      <SourceSelector
        mode="open"
        selectedSources={['Web']}
        onSourceToggle={jest.fn()}
        onCustomSourceAdd={jest.fn()}
        onFileUpload={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /custom/i }));

    fireEvent.change(screen.getByPlaceholderText('Add website URL'), {
      target: { value: 'not-a-url' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByText('Please enter a valid URL')).toBeTruthy();
  });

  it('uploads files and passes parsed files to the callback', async () => {
    const onFileUpload = jest.fn();
    uploadFiles.mockResolvedValue({
      files: [{ name: 'brief.pdf', content: 'parsed brief' }],
    });

    const { container } = render(
      <SourceSelector
        mode="open"
        selectedSources={['Web']}
        onSourceToggle={jest.fn()}
        onCustomSourceAdd={jest.fn()}
        onFileUpload={onFileUpload}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /custom/i }));

    const fileInput = container.querySelector('input[type="file"]');
    const file = new File(['hello'], 'brief.pdf', { type: 'application/pdf' });

    fireEvent.change(fileInput, {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(uploadFiles).toHaveBeenCalledTimes(1);
      expect(onFileUpload).toHaveBeenCalledWith([
        { name: 'brief.pdf', content: 'parsed brief' },
      ]);
    });
  });

  it('shows upload errors from the backend response', async () => {
    uploadFiles.mockRejectedValue({
      response: {
        data: {
          error: 'Upload payload too large',
        },
      },
    });

    const { container } = render(
      <SourceSelector
        mode="open"
        selectedSources={['Web']}
        onSourceToggle={jest.fn()}
        onCustomSourceAdd={jest.fn()}
        onFileUpload={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /custom/i }));

    const fileInput = container.querySelector('input[type="file"]');
    const file = new File(['hello'], 'brief.pdf', { type: 'application/pdf' });

    fireEvent.change(fileInput, {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByText('Upload payload too large')).toBeTruthy();
    });
  });
});
