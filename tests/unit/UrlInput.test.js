/** @jest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import UrlInput from '../../src/components/UrlInput';

describe('UrlInput', () => {
  it('submits non-empty urls and clears the input', () => {
    const onSubmit = jest.fn();

    render(<UrlInput onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText('Enter URL');
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(onSubmit).toHaveBeenCalledWith('https://example.com');
    expect(input.value).toBe('');
  });

  it('does not submit empty urls', () => {
    const onSubmit = jest.fn();

    render(<UrlInput onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
