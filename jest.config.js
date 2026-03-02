module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/unit/**/*.test.js'],
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
