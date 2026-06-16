const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withEntitlementsPlist,
  withInfoPlist,
} = require('expo/config-plugins');

const pkg = require('./package.json');

const DEFAULT_LOCAL_NETWORK_USAGE =
  'This app uses the local network to send and receive UDP packets.';

function dedupeAndroidPermissions(androidManifest) {
  const permissions = androidManifest.manifest['uses-permission'];
  if (!Array.isArray(permissions)) {
    return;
  }

  const seen = new Set();
  androidManifest.manifest['uses-permission'] = permissions.filter((permission) => {
    const name = permission.$?.['android:name'];
    if (!name || seen.has(name)) {
      return false;
    }
    seen.add(name);
    return true;
  });
}

function withExpoUdp(config, props = {}) {
  const {
    localNetworkUsageDescription = DEFAULT_LOCAL_NETWORK_USAGE,
    multicast = false,
  } = props;

  config = withAndroidManifest(config, (androidConfig) => {
    AndroidConfig.Permissions.addPermission(androidConfig.modResults, 'android.permission.INTERNET');

    if (multicast) {
      AndroidConfig.Permissions.addPermission(
        androidConfig.modResults,
        'android.permission.CHANGE_WIFI_MULTICAST_STATE'
      );
    }

    dedupeAndroidPermissions(androidConfig.modResults);

    return androidConfig;
  });

  config = withInfoPlist(config, (iosConfig) => {
    iosConfig.modResults.NSLocalNetworkUsageDescription = localNetworkUsageDescription;
    return iosConfig;
  });

  if (multicast) {
    config = withEntitlementsPlist(config, (iosConfig) => {
      iosConfig.modResults['com.apple.developer.networking.multicast'] = true;
      return iosConfig;
    });
  }

  return config;
}

module.exports = createRunOncePlugin(withExpoUdp, pkg.name, pkg.version);
