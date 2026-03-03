/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import CategoryDebugPage from '../../src/pages/category-debug';

jest.mock('../../src/components/search/categories/SimpleModernCategories', () => function MockSimpleModernCategories(props) {
  return (
    <div data-testid="simple-modern-categories">
      query:{props.query}
      categories:{props.categories.length}
      results:{props.results.length}
    </div>
  );
});

describe('Category debug page', () => {
  it('renders debug controls and updates the query state', () => {
    render(<CategoryDebugPage />);

    const queryInput = screen.getByDisplayValue('test query');

    expect(screen.getByRole('heading', { name: 'Category Display Debug Page' })).toBeTruthy();
    expect(screen.getByTestId('simple-modern-categories').textContent).toContain('query:test query');
    expect(screen.getByTestId('simple-modern-categories').textContent).toContain('categories:3');

    fireEvent.change(queryInput, { target: { value: 'updated query' } });

    expect(screen.getByDisplayValue('updated query')).toBeTruthy();
    expect(screen.getByTestId('simple-modern-categories').textContent).toContain('query:updated query');
  });
});
