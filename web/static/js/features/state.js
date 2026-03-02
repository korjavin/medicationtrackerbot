(function () {
    window.medications = [];
    window.featureSettings = {
        food: false,
        bp: false,
        weight: false,
        health: false,
        medication: true,
        workout: true
    };
    window.featureSettingsLoaded = false;
    window.editingMedId = null;
    window.foodTargets = {
        calories: 0,
        carbs: 0,
        protein: 0,
        fat: 0
    };
})();
