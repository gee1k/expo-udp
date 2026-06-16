Pod::Spec.new do |s|
  s.name           = 'ExpoUdp'
  s.version        = '0.1.0'
  s.summary        = 'Modern UDP sockets for Expo on iOS and Android'
  s.description    = 'A modern Expo native module for low-level UDP sockets, broadcast, and multicast.'
  s.author         = 'Svend'
  s.homepage       = 'https://github.com/gee1k/expo-udp'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: 'https://github.com/gee1k/expo-udp.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
