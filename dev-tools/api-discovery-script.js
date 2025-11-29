// X API Discovery Script
// Copy and paste this into browser console while on x.com
// Then click on "Joined" dates on various profiles to see API calls

(function() {
  console.log('🔍 X API Discovery Script Active');
  console.log('Now click on "Joined" dates on user profiles...');

  const originalFetch = window.fetch;
  const discoveredEndpoints = new Map();

  window.fetch = async function(...args) {
    const url = args[0];
    const response = await originalFetch(...args);

    // Only log X API calls
    if (url.includes('x.com/i/api/') || url.includes('api.x.com/')) {
      console.log('📡 API REQUEST:', url);

      const clonedResponse = response.clone();

      try {
        const data = await clonedResponse.json();
        console.log('📦 API RESPONSE:', url, data);

        // Try to find country/location data in response
        const jsonStr = JSON.stringify(data, null, 2);
        const locationKeywords = ['country', 'location', 'region', 'geo', 'based'];
        const foundKeywords = locationKeywords.filter(kw =>
          jsonStr.toLowerCase().includes(kw)
        );

        if (foundKeywords.length > 0) {
          console.log('⭐ POTENTIAL COUNTRY DATA FOUND!', {
            url: url,
            keywords: foundKeywords,
            data: data
          });

          discoveredEndpoints.set(url, {
            keywords: foundKeywords,
            timestamp: Date.now(),
            response: data
          });
        }
      } catch (e) {
        console.log('⚠️ Could not parse response as JSON');
      }
    }

    return response;
  };

  // Add helper function to view discovered endpoints
  window.showDiscoveredEndpoints = function() {
    console.log('📊 Discovered Endpoints with Location Data:');
    discoveredEndpoints.forEach((info, url) => {
      console.log('\n' + '='.repeat(80));
      console.log('URL:', url);
      console.log('Keywords found:', info.keywords);
      console.log('Response:', info.response);
    });

    if (discoveredEndpoints.size === 0) {
      console.log('No endpoints with location data found yet.');
      console.log('Try clicking on more "Joined" dates on profiles.');
    }
  };

  console.log('💡 Type showDiscoveredEndpoints() to see summary of findings');
})();
