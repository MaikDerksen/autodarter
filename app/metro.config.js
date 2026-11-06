// Metro config: allow importing the shared game engine from ../shared/src
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const sharedDir = path.resolve(__dirname, '../shared');

config.watchFolders = [...(config.watchFolders ?? []), sharedDir];
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : config.resolver.blockList ? [config.resolver.blockList] : []),
  new RegExp(`${sharedDir.replace(/[\\/]/g, '[\\\\/]')}[\\\\/]node_modules[\\\\/].*`),
];
// shared/ has no dependencies of its own – resolve everything from the app's node_modules
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];

module.exports = config;
