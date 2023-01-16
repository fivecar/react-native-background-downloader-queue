module.exports = {
  presets: ["module:metro-react-native-babel-preset", "@babel/preset-flow"],
  plugins: [
    "module:@babel/plugin-proposal-private-methods",
    "module:@babel/plugin-proposal-class-properties",
    "module:@babel/plugin-proposal-private-property-in-object",
  ],
};
