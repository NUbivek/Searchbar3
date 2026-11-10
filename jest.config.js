module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/unit/**/*.test.js'],
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': '<rootDir>/tests/unit/styleMock.js',
    // d3-hierarchy ships ES modules; tests use its bundled UMD build.
    '^d3-hierarchy$': '<rootDir>/node_modules/d3-hierarchy/dist/d3-hierarchy.min.js',
  },
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', {
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        '@babel/preset-react',
      ],
    }],
  },
  moduleFileExtensions: ['js', 'jsx', 'json'],
};
