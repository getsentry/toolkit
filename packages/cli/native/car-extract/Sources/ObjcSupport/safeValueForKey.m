// Copyright 2008-2025 Functional Software, Inc. dba Sentry
// FSL-1.1-MIT; see ../../README.md for the upstream source and license.
#import <Foundation/Foundation.h>
#import "safeValueForKey.h"

// Helper to call `valueForKey` without Swift crashing.
id safeValueForKey(id object, NSString *key) {
  @try {
    return [object valueForKey:key];
  } @catch (NSException *exception) {
    return nil;
  }
}
