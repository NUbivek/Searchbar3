module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/unit/**/*.test.js'],
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': '<rootDir>/tests/unit/styleMock.js',
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
