/** @jest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FileUpload from '../../src/components/FileUpload';

describe('FileUpload', () => {
  it('passes selected files to onUpload and renders upload progress rows', async () => {
    const onUpload = jest.fn();

    render(<FileUpload onUpload={onUpload} />);

    const input = document.querySelector('input[type="file"]');
    expect(input).toBeTruthy();

    const files = [
      new File(['resume body'], 'resume.txt', { type: 'text/plain' }),
      new File(['brief body'], 'brief.csv', { type: 'text/csv' }),
    ];

    fireEvent.change(input, { target: { files } });

    await waitFor(() => {
      expect(onUpload).toHaveBeenCalledWith(files);
    });

    expect(screen.getByText('resume.txt')).toBeTruthy();
    expect(screen.getByText('brief.csv')).toBeTruthy();

    const progressBars = document.querySelectorAll('.bg-blue-600');
    expect(progressBars).toHaveLength(2);
    expect(progressBars[0].style.width).toBe('100%');
    expect(progressBars[1].style.width).toBe('100%');
  });
});
