const base = require('./.shell/pkg/vue.config')(__dirname);

const previousChainWebpack = base.chainWebpack;

base.chainWebpack = (config) => {
  if (typeof previousChainWebpack === 'function') {
    previousChainWebpack(config);
  }

  // Inline fonts into the bundle as data URIs instead of emitting them as files.
  //
  // A built extension is a UMD bundle that Rancher serves from a path of its
  // choosing, and nothing in the shell sets webpack's public path to match, so
  // where an emitted file would be fetched from is not something this build gets
  // to know. Inlining takes the question away, which is worth ~330KB for a font
  // the terminal cannot do without. The default threshold is 8KB and these are
  // ~125KB each, hence the number.
  config.module.rule('fonts').parser({ dataUrlCondition: { maxSize: 512 * 1024 } });
};

module.exports = base;
